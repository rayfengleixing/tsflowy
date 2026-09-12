use rusqlite::{params, Connection, OptionalExtension};

use super::models::ViewRow;
use super::{dberr, now_ms};

fn row_to_view(r: &rusqlite::Row<'_>) -> rusqlite::Result<ViewRow> {
    Ok(ViewRow {
        id: r.get("id")?,
        workspace_id: r.get("workspace_id")?,
        parent_id: r.get("parent_id")?,
        name: r.get("name")?,
        icon: r.get("icon")?,
        layout: r.get("layout")?,
        extra: r.get("extra")?,
        position: r.get("position")?,
        is_favorite: r.get("is_favorite")?,
        is_trash: r.get("is_trash")?,
        deleted_at: r.get("deleted_at")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        visited_at: r.get("visited_at")?,
    })
}

fn query_views(
    conn: &Connection,
    sql: &str,
    p: impl rusqlite::Params,
    ctx: &'static str,
) -> Result<Vec<ViewRow>, String> {
    let mut stmt = conn.prepare(sql).map_err(dberr(ctx))?;
    let rows = stmt
        .query_map(p, row_to_view)
        .map_err(dberr(ctx))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr(ctx))?;
    Ok(rows)
}

pub fn list_by_workspace(conn: &Connection, workspace_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 0
           AND json_extract(extra, '$.row_detail') IS NOT 1
         ORDER BY position ASC",
        params![workspace_id],
        "list views",
    )
}

pub fn list_trash(conn: &Connection, workspace_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 1
           AND json_extract(extra, '$.row_detail') IS NOT 1
         ORDER BY deleted_at DESC",
        params![workspace_id],
        "list trash",
    )
}

pub fn list_recent(conn: &Connection, workspace_id: &str, limit: i64) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 0 AND visited_at IS NOT NULL
           AND json_extract(extra, '$.row_detail') IS NOT 1
         ORDER BY visited_at DESC LIMIT ?2",
        params![workspace_id, limit],
        "list recent views",
    )
}

pub fn touch_visited(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE views SET visited_at = ?1 WHERE id = ?2", params![now_ms(), id])
        .map_err(dberr("touch visited"))?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<ViewRow>, String> {
    conn.query_row("SELECT * FROM views WHERE id = ?1", params![id], row_to_view)
        .optional()
        .map_err(dberr("get view"))
}

/// 单事务：同父 MAX(position)+1 → INSERT views → document 布局再插默认内容行（H1 标题 + 分割线，
/// 前端 document-structure-lock 锁定二者；documents_fts 的 insert 触发器随之生效）。
pub fn create(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    parent_id: Option<&str>,
    name: &str,
    layout: &str,
    extra: &str,
) -> Result<ViewRow, String> {
    let t = now_ms();
    let tx = conn.unchecked_transaction().map_err(dberr("create view"))?;
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE workspace_id = ?1 AND parent_id IS ?2",
            params![workspace_id, parent_id],
            |r| r.get(0),
        )
        .map_err(dberr("create view"))?;
    tx.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, workspace_id, parent_id, name, layout, extra, position, t],
    )
    .map_err(dberr("create view"))?;
    if layout == "document" {
        // 默认结构：首行 H1 标题 + 第二行分割线（前端 document-structure-lock 锁定二者不可修改）
        let content = format!(
            r#"{{"type":"doc","content":[{{"type":"heading","attrs":{{"level":1}},"content":[{{"type":"text","text":{}}}]}},{{"type":"horizontalRule"}}]}}"#,
            serde_json::to_string(name).map_err(|e| format!("encode doc content: {e}"))?,
        );
        tx.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES (?1, ?2, ?3)",
            params![id, content, t],
        )
        .map_err(dberr("create view document"))?;
    }
    tx.commit().map_err(dberr("create view (commit)"))?;
    Ok(ViewRow {
        id: id.to_string(),
        workspace_id: workspace_id.to_string(),
        parent_id: parent_id.map(|s| s.to_string()),
        name: name.to_string(),
        icon: None,
        layout: layout.to_string(),
        extra: extra.to_string(),
        position,
        is_favorite: 0,
        is_trash: 0,
        deleted_at: None,
        created_at: t,
        updated_at: t,
        visited_at: None,
    })
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE views SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_ms(), id],
    )
    .map_err(dberr("rename view"))?;
    Ok(())
}

pub fn set_icon(conn: &Connection, id: &str, icon: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE views SET icon = ?1, updated_at = ?2 WHERE id = ?3",
        params![icon, now_ms(), id],
    )
    .map_err(dberr("set view icon"))?;
    Ok(())
}

fn with_recursive_subtree(conn: &Connection, body: &str, id: &str, extra: Option<i64>, ctx: &'static str) -> Result<usize, String> {
    let sql = format!(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM views WHERE id = ?1
           UNION ALL
           SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
         )
         {body}"
    );
    let n = match extra {
        Some(ts) => conn.execute(&sql, params![id, ts]),
        None => conn.execute(&sql, params![id]),
    }
    .map_err(dberr(ctx))?;
    Ok(n)
}

/// 软删：视图及其整个子树进回收站
pub fn soft_delete(conn: &Connection, id: &str) -> Result<(), String> {
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE id IN (SELECT id FROM sub)",
        id,
        Some(now_ms()),
        "soft delete view",
    )
    .map(|_| ())
}

/// 恢复：视图及其子树移出回收站
pub fn restore(conn: &Connection, id: &str) -> Result<(), String> {
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE id IN (SELECT id FROM sub)",
        id,
        None,
        "restore view",
    )
    .map(|_| ())
}

/// 彻底删除：子树递归硬删（documents/database_* 经 FK 级联 + FTS delete 触发器）
pub fn purge(conn: &Connection, id: &str) -> Result<(), String> {
    with_recursive_subtree(
        conn,
        "DELETE FROM views WHERE id IN (SELECT id FROM sub)",
        id,
        None,
        "purge view",
    )
    .map(|_| ())
}

pub fn purge_trash(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM views WHERE workspace_id = ?1 AND is_trash = 1",
        params![workspace_id],
    )
    .map_err(dberr("purge trash"))?;
    Ok(())
}

/// 永久删除回收站中 deleted_at 早于 deadline_ms（毫秒时间戳）的视图，返回删除行数（30 天自动清空）
pub fn purge_expired_trash(conn: &Connection, workspace_id: &str, deadline_ms: i64) -> Result<i64, String> {
    let n = conn
        .execute(
            "DELETE FROM views WHERE workspace_id = ?1 AND is_trash = 1
               AND deleted_at IS NOT NULL AND deleted_at < ?2",
            params![workspace_id, deadline_ms],
        )
        .map_err(dberr("purge expired trash"))?;
    Ok(n as i64)
}

// ---------- 移动 / 重排（tree.ts computeRenumber 的 Rust 镜像，单命令单事务） ----------

struct PositionUpdate {
    id: String,
    parent_id: Option<String>,
    position: i64,
}

/// parentId 下除 movedId 外的兄弟 id（按 position 排序；稳定排序与 JS 一致）
fn sibling_ids(views: &[ViewRow], parent_id: Option<&str>, moved_id: Option<&str>) -> Vec<String> {
    let mut pairs: Vec<(i64, String)> = views
        .iter()
        .filter(|v| v.parent_id.as_deref() == parent_id && Some(v.id.as_str()) != moved_id)
        .map(|v| (v.position, v.id.clone()))
        .collect();
    pairs.sort_by_key(|(p, _)| *p);
    pairs.into_iter().map(|(_, id)| id).collect()
}

/// 把 moved_id 放到 new_parent_id 下 index 位置，返回所有需更新的行。
/// 与 tree.ts computeRenumber 逐行为对齐：越界收敛、无变化短路、旧父级兄弟压缩。
fn compute_renumber(
    views: &[ViewRow],
    moved_id: &str,
    new_parent_id: Option<&str>,
    index: i64,
) -> Vec<PositionUpdate> {
    let Some(moving) = views.iter().find(|v| v.id == moved_id) else {
        return Vec::new();
    };
    let old_parent = moving.parent_id.clone();

    let mut new_ids = sibling_ids(views, new_parent_id, Some(moved_id));
    let idx = (index.max(0) as usize).min(new_ids.len());
    new_ids.insert(idx, moved_id.to_string());
    // 同父级且顺序不变 → 无需更新
    if old_parent.as_deref() == new_parent_id && new_ids == sibling_ids(views, new_parent_id, None) {
        return Vec::new();
    }

    let mut updates: Vec<PositionUpdate> = new_ids
        .iter()
        .enumerate()
        .map(|(i, id)| PositionUpdate {
            id: id.clone(),
            parent_id: new_parent_id.map(|s| s.to_string()),
            position: i as i64,
        })
        .collect();

    if old_parent.as_deref() != new_parent_id {
        for (i, id) in sibling_ids(views, old_parent.as_deref(), Some(moved_id))
            .into_iter()
            .enumerate()
        {
            updates.push(PositionUpdate {
                id,
                parent_id: old_parent.clone(),
                position: i as i64,
            });
        }
    }
    updates
}

/// 单事务移动：SELECT 全 workspace 视图（含 trash，同旧 db.ts）→ 后代环守卫（静默 no-op）
/// → compute_renumber → prepared statement 逐行 UPDATE。
pub fn move_view(
    conn: &Connection,
    view_id: &str,
    new_parent_id: Option<&str>,
    index: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("move view"))?;
    let views = query_views(
        &tx,
        "SELECT * FROM views WHERE workspace_id = (SELECT workspace_id FROM views WHERE id = ?1)",
        params![view_id],
        "move view",
    )?;

    // 防呆：目标不能是自身的后代（UI 已拦截，此处兜底）
    if let Some(np) = new_parent_id {
        let mut cursor = np.to_string();
        loop {
            if cursor == view_id {
                return Ok(());
            }
            match views.iter().find(|v| v.id == cursor).and_then(|v| v.parent_id.clone()) {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    let updates = compute_renumber(&views, view_id, new_parent_id, index);
    if updates.is_empty() {
        return Ok(());
    }
    let t = now_ms();
    {
        let mut stmt = tx
            .prepare("UPDATE views SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4")
            .map_err(dberr("move view"))?;
        for u in &updates {
            stmt.execute(params![u.parent_id, u.position, t, u.id])
                .map_err(dberr("move view"))?;
        }
    }
    tx.commit().map_err(dberr("move view (commit)"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn
    }

    /// 与 tree.test.ts 同款 fixture：r1/r2/r3 根级（0-2），c1/c2/c3 在 r1 下（0-2）
    fn seed_default_fixture(conn: &Connection) {
        for (id, parent, pos) in [
            ("r1", None, 0),
            ("r2", None, 1),
            ("r3", None, 2),
            ("c1", Some("r1"), 0),
            ("c2", Some("r1"), 1),
            ("c3", Some("r1"), 2),
        ] {
            conn.execute(
                "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
                 VALUES (?1, 'w1', ?2, ?1, 'document', '{}', ?3, 1, 1)",
                params![id, parent, pos],
            )
            .unwrap();
        }
    }

    /// id → (parent_id, position)，按 id 排序便于整体断言
    fn layout(conn: &Connection) -> BTreeMap<String, (Option<String>, i64)> {
        let mut stmt = conn
            .prepare("SELECT id, parent_id, position FROM views")
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows.into_iter().map(|(id, p, pos)| (id, (p, pos))).collect()
    }

    #[test]
    fn move_same_parent_reorder() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c3", Some("r1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c3"], (Some("r1".into()), 0));
        assert_eq!(l["c1"], (Some("r1".into()), 1));
        assert_eq!(l["c2"], (Some("r1".into()), 2));
        assert_eq!(l["r1"], (None, 0));
    }

    #[test]
    fn move_cross_parent_index_clamped_to_end() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c1", None, 99).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c1"], (None, 3)); // 追加到根级末尾
        assert_eq!(l["r1"], (None, 0)); // 旧父级保持
        assert_eq!(l["c2"], (Some("r1".into()), 0)); // 旧父级兄弟压缩
        assert_eq!(l["c3"], (Some("r1".into()), 1));
        assert_eq!(l["r2"], (None, 1));
    }

    #[test]
    fn move_cross_parent_head() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "r3", Some("r1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["r3"], (Some("r1".into()), 0));
        assert_eq!(l["c1"], (Some("r1".into()), 1));
        assert_eq!(l["c2"], (Some("r1".into()), 2));
        assert_eq!(l["c3"], (Some("r1".into()), 3));
        assert_eq!(l["r1"], (None, 0));
        assert_eq!(l["r2"], (None, 1));
    }

    #[test]
    fn move_to_root_middle() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c2", None, 1).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c2"], (None, 1));
        assert_eq!(l["r2"], (None, 2));
        assert_eq!(l["r3"], (None, 3));
        assert_eq!(l["c1"], (Some("r1".into()), 0));
    }

    #[test]
    fn move_to_same_position_is_noop() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c2", Some("r1"), 1).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c2"], (Some("r1".into()), 1));
        assert_eq!(l["c1"], (Some("r1".into()), 0));
        assert_eq!(l["c3"], (Some("r1".into()), 2));
    }

    #[test]
    fn move_into_own_descendant_is_silent_noop() {
        let conn = setup();
        seed_default_fixture(&conn);
        // c1 是 r1 的后代：环守卫必须静默拒绝
        move_view(&conn, "r1", Some("c1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["r1"], (None, 0));
        assert_eq!(l["c1"], (Some("r1".into()), 0));
        assert_eq!(l["c2"], (Some("r1".into()), 1));
        assert_eq!(l["c3"], (Some("r1".into()), 2));
    }

    #[test]
    fn move_unknown_target_is_noop() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "ghost", None, 0).unwrap();
        assert_eq!(layout(&conn).len(), 6);
    }

    #[test]
    fn create_document_seeds_content_row_and_fts() {
        let conn = setup();
        let name = r#"He said "hi" \ ok"#;
        let v = create(&conn, "v1", "w1", None, name, "document", "{}").unwrap();
        assert_eq!(v.position, 0);
        assert_eq!(v.is_trash, 0);
        let content: String = conn
            .query_row("SELECT content FROM documents WHERE view_id = 'v1'", [], |r| r.get(0))
            .unwrap();
        // 默认结构：H1 标题 + 分割线（与前端 document-structure-lock 的保护区一致）
        assert_eq!(
            content,
            r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"He said \"hi\" \\ ok"}]},{"type":"horizontalRule"}]}"#
        );
        // documents INSERT 触发器已写 FTS
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM documents_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 1);
    }

    #[test]
    fn create_grid_has_no_document_row() {
        let conn = setup();
        create(&conn, "v1", "w1", None, "grid", "grid", "{}").unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn create_position_increments_per_parent() {
        let conn = setup();
        create(&conn, "a", "w1", None, "a", "grid", "{}").unwrap();
        create(&conn, "b", "w1", None, "b", "grid", "{}").unwrap();
        create(&conn, "c", "w1", Some("a"), "c", "grid", "{}").unwrap();
        let pa: i64 = conn.query_row("SELECT position FROM views WHERE id='a'", [], |r| r.get(0)).unwrap();
        let pb: i64 = conn.query_row("SELECT position FROM views WHERE id='b'", [], |r| r.get(0)).unwrap();
        let pc: i64 = conn.query_row("SELECT position FROM views WHERE id='c'", [], |r| r.get(0)).unwrap();
        assert_eq!((pa, pb, pc), (0, 1, 0));
    }

    #[test]
    fn subtree_soft_delete_restore_and_purge() {
        let conn = setup();
        seed_default_fixture(&conn);
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();

        soft_delete(&conn, "c1").unwrap();
        for (id, trashed) in [("c1", 1), ("d1", 1), ("r1", 0)] {
            let t: i64 = conn.query_row("SELECT is_trash FROM views WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
            assert_eq!(t, trashed, "{id} trash state");
        }
        let del: Option<i64> = conn.query_row("SELECT deleted_at FROM views WHERE id='c1'", [], |r| r.get(0)).unwrap();
        assert!(del.is_some());

        restore(&conn, "c1").unwrap();
        let t: i64 = conn.query_row("SELECT is_trash FROM views WHERE id='d1'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, 0);

        purge(&conn, "c1").unwrap();
        for id in ["c1", "d1"] {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{id} purged");
        }
        let r1: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id='r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(r1, 1);
    }

    #[test]
    fn purge_expired_trash_counts_and_respects_null_deleted_at() {
        let conn = setup();
        seed_default_fixture(&conn);
        let old = now_ms() - 40 * 24 * 3600 * 1000;
        conn.execute("UPDATE views SET is_trash = 1, deleted_at = ?1 WHERE id = 'r2'", params![old]).unwrap();
        conn.execute("UPDATE views SET is_trash = 1 WHERE id = 'r3'", []).unwrap(); // deleted_at 仍为 NULL

        let n = purge_expired_trash(&conn, "w1", now_ms() - 30 * 24 * 3600 * 1000).unwrap();
        assert_eq!(n, 1);
        let r2: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id='r2'", [], |r| r.get(0)).unwrap();
        assert_eq!(r2, 0);
        let r3: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id='r3'", [], |r| r.get(0)).unwrap();
        assert_eq!(r3, 1);
    }
}
