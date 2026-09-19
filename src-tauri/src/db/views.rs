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
        source_id: r.get("source_id")?,
        tags: r.get("tags")?,
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

/// 树 / 回收站 / 最近访问的可见性口径：行详情文档与派生视图（多视图）都不是"页面"，一律排除。
const VISIBLE_IN_TREE: &str = " AND json_extract(extra, '$.row_detail') IS NOT 1 AND source_id IS NULL";

pub fn list_by_workspace(conn: &Connection, workspace_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        &format!(
            "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 0{VISIBLE_IN_TREE} ORDER BY position ASC"
        ),
        params![workspace_id],
        "list views",
    )
}

pub fn list_trash(conn: &Connection, workspace_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        &format!(
            "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 1{VISIBLE_IN_TREE} ORDER BY deleted_at DESC"
        ),
        params![workspace_id],
        "list trash",
    )
}

pub fn list_recent(conn: &Connection, workspace_id: &str, limit: i64) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        &format!(
            "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 0 AND visited_at IS NOT NULL\
             {VISIBLE_IN_TREE} ORDER BY visited_at DESC LIMIT ?2"
        ),
        params![workspace_id, limit],
        "list recent views",
    )
}

/// 一张表的全部视图（宿主 + 派生），供页面内的视图标签栏使用。
/// 宿主恒排第一：它的 position 是树里的排序位，与派生视图的 position 空间互不相干。
pub fn list_for_source(conn: &Connection, source_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        "SELECT * FROM views WHERE (id = ?1 OR source_id = ?1) AND is_trash = 0
         ORDER BY (source_id IS NULL) DESC, position ASC",
        params![source_id],
        "list views of source",
    )
}

/// 数据宿主解析：派生视图一律折算到宿主 id —— fields/rows/cells 只挂在宿主上。
/// source_id 创建后不可变（无写入路径），故各入口查一次即可，无需缓存。
/// 视图行不存在时原样返回：保持旧行为（查询得到空集），避免已删视图的残留标签页弹错。
pub fn data_view_id(conn: &Connection, view_id: &str) -> Result<String, String> {
    let resolved: Option<String> = conn
        .query_row(
            "SELECT COALESCE(source_id, id) FROM views WHERE id = ?1",
            params![view_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr("resolve data view"))?;
    Ok(resolved.unwrap_or_else(|| view_id.to_string()))
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

/// 单事务：同级 MAX(position)+1 → INSERT views → document 布局再插默认内容行（H1 标题 + 分割线，
/// 前端 document-structure-lock 锁定二者；documents_fts 的 insert 触发器随之生效）。
///
/// `source_id = Some(host)` 建的是宿主表的一个派生视图（多视图）：不进树（parent_id 强制 NULL）、
/// position 在"该宿主的视图列表"内递增、不碰宿主的树内 position。
pub fn create(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    parent_id: Option<&str>,
    name: &str,
    layout: &str,
    extra: &str,
    source_id: Option<&str>,
) -> Result<ViewRow, String> {
    if source_id.is_some() && layout == "document" {
        return Err("a derived view of a database cannot use the document layout".to_string());
    }
    let t = now_ms();
    let tx = conn.unchecked_transaction().map_err(dberr("create view"))?;
    let parent_id = match source_id {
        // 派生视图不属于页面树
        Some(_) => None,
        None => parent_id,
    };
    let position: i64 = match source_id {
        Some(host) => {
            // 宿主必须是已存在的宿主（不允许派生视图再挂派生视图，否则数据归属要递归解析）
            let is_host: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM views WHERE id = ?1 AND source_id IS NULL",
                    params![host],
                    |r| r.get(0),
                )
                .map_err(dberr("create derived view"))?;
            if is_host == 0 {
                return Err(format!("database view not found: {host}"));
            }
            tx.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE source_id = ?1",
                params![host],
                |r| r.get(0),
            )
            .map_err(dberr("create derived view"))?
        }
        None => tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE workspace_id = ?1 AND parent_id IS ?2",
                params![workspace_id, parent_id],
                |r| r.get(0),
            )
            .map_err(dberr("create view"))?,
    };
    tx.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at, source_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
        params![id, workspace_id, parent_id, name, layout, extra, position, t, source_id],
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
        source_id: source_id.map(|s| s.to_string()),
        tags: "[]".to_string(),
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

/// 收藏/取消收藏（侧边栏收藏区置顶显示）
pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE views SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i64, now_ms(), id],
        )
        .map_err(dberr("set view favorite"))?;
    if n == 0 {
        return Err(format!("view not found: {id}"));
    }
    Ok(())
}

/// 设置页面标签（整体覆写 JSON 数组；空数组 = 清空标签）。
/// 这里校验 + 去重 + 规整成紧凑 JSON，前端直接读字符串。
pub fn set_tags(conn: &Connection, id: &str, tags: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(tags).map_err(|e| format!("invalid tags JSON: {e}"))?;
    let serde_json::Value::Array(arr) = parsed else {
        return Err("tags must be a JSON array".to_string());
    };
    let mut seen: Vec<String> = Vec::new();
    for v in &arr {
        let Some(s) = v.as_str() else {
            return Err("tags must be strings".to_string());
        };
        let trimmed = s.trim();
        if trimmed.is_empty() || seen.iter().any(|x| x == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
    }
    let normalized = serde_json::to_string(&seen).map_err(|e| format!("encode tags: {e}"))?;
    let n = conn
        .execute(
            "UPDATE views SET tags = ?1, updated_at = ?2 WHERE id = ?3",
            params![normalized, now_ms(), id],
        )
        .map_err(dberr("set view tags"))?;
    if n == 0 {
        return Err(format!("view not found: {id}"));
    }
    Ok(())
}

/// 整体覆写视图 extra（视图模式/筛选/排序/看板分组字段/日历日期字段等显示配置）。
/// 合并语义在前端做（读改写整份 extra），这里只校验来料必须是 JSON 对象，
/// 以免把 row_detail 之类的既有标记冲成不可解析文本。
pub fn update_extra(conn: &Connection, id: &str, extra: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(extra).map_err(|e| format!("invalid extra JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("extra must be a JSON object".to_string());
    }
    let n = conn
        .execute(
            "UPDATE views SET extra = ?1, updated_at = ?2 WHERE id = ?3",
            params![extra, now_ms(), id],
        )
        .map_err(dberr("update view extra"))?;
    if n == 0 {
        return Err(format!("view not found: {id}"));
    }
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

/// 软删：视图及其整个子树进回收站（含数据库表的派生视图，否则恢复时视图配置丢失）
pub fn soft_delete(conn: &Connection, id: &str) -> Result<(), String> {
    let t = now_ms();
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE id IN (SELECT id FROM sub)",
        id,
        Some(t),
        "soft delete view",
    )?;
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE source_id IN (SELECT id FROM sub)",
        id,
        Some(t),
        "soft delete derived views",
    )
    .map(|_| ())
}

/// 恢复：视图及其子树移出回收站（含派生视图）
pub fn restore(conn: &Connection, id: &str) -> Result<(), String> {
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE id IN (SELECT id FROM sub)",
        id,
        None,
        "restore view",
    )?;
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE source_id IN (SELECT id FROM sub)",
        id,
        None,
        "restore derived views",
    )
    .map(|_| ())
}

/// 彻底删除：子树递归硬删（documents/database_* 经 FK 级联 + FTS delete 触发器；
/// 数据库表的派生视图经 views.source_id 的 FK 级联随之删除）
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

/// 单事务移动：SELECT 全 workspace 视图（含 trash，同旧 db.ts；排除派生视图——它们 parent_id 为 NULL
/// 但不属于页面树）→ 后代环守卫（静默 no-op）→ compute_renumber → prepared statement 逐行 UPDATE。
pub fn move_view(
    conn: &Connection,
    view_id: &str,
    new_parent_id: Option<&str>,
    index: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("move view"))?;
    let views = query_views(
        &tx,
        "SELECT * FROM views WHERE workspace_id = (SELECT workspace_id FROM views WHERE id = ?1)
           AND source_id IS NULL",
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
        let v = create(&conn, "v1", "w1", None, name, "document", "{}", None).unwrap();
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
        create(&conn, "v1", "w1", None, "grid", "grid", "{}", None).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn create_position_increments_per_parent() {
        let conn = setup();
        create(&conn, "a", "w1", None, "a", "grid", "{}", None).unwrap();
        create(&conn, "b", "w1", None, "b", "grid", "{}", None).unwrap();
        create(&conn, "c", "w1", Some("a"), "c", "grid", "{}", None).unwrap();
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

    // ---------- 多视图（迁移 007：views.source_id） ----------

    /// 在宿主表上建一个派生视图
    fn derive(conn: &Connection, id: &str, host: &str, name: &str, layout: &str) -> ViewRow {
        create(conn, id, "w1", None, name, layout, "{}", Some(host)).unwrap()
    }

    fn ids(rows: &[ViewRow]) -> Vec<String> {
        rows.iter().map(|v| v.id.clone()).collect()
    }

    #[test]
    fn derived_views_hide_from_tree_trash_and_recent() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");
        conn.execute("UPDATE views SET visited_at = 5 WHERE id = 'd1'", []).unwrap();

        // 活跃态：派生视图既不在树里，也不因 visited_at 出现在最近
        assert_eq!(ids(&list_by_workspace(&conn, "w1").unwrap()), vec!["g1"]);
        assert!(list_recent(&conn, "w1", 10).unwrap().is_empty(), "派生视图不进最近列表");

        // 回收站：派生视图随宿主一起软删，但不单独占一行
        soft_delete(&conn, "g1").unwrap();
        assert_eq!(ids(&list_trash(&conn, "w1").unwrap()), vec!["g1"]);
    }

    #[test]
    fn list_for_source_returns_host_first_then_derived_by_position() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d2", "g1", "日历", "calendar");
        derive(&conn, "d1", "g1", "看板", "board");
        assert_eq!(ids(&list_for_source(&conn, "g1").unwrap()), vec!["g1", "d2", "d1"]);

        // 宿主自身的派生视图不会漏，别的表也串不进来
        create(&conn, "g2", "w1", None, "另一张表", "grid", "{}", None).unwrap();
        assert_eq!(ids(&list_for_source(&conn, "g2").unwrap()), vec!["g2"]);
    }

    #[test]
    fn create_derived_view_scopes_position_and_rejects_bad_host() {
        let conn = setup();
        // 宿主的树内 position 已占用 0/1，派生视图的 position 另起一套从 0 开始
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        create(&conn, "g2", "w1", None, "表2", "grid", "{}", None).unwrap();
        assert_eq!(derive(&conn, "d1", "g1", "看板", "board").position, 0);
        assert_eq!(derive(&conn, "d2", "g1", "日历", "calendar").position, 1);
        let g1_pos: i64 = conn.query_row("SELECT position FROM views WHERE id='g1'", [], |r| r.get(0)).unwrap();
        assert_eq!(g1_pos, 0, "派生视图不抢宿主的树内排序位");

        // 派生视图不进树：parent_id 强制 NULL，哪怕调用方传了父节点
        let d = create(&conn, "d3", "w1", Some("g2"), "x", "grid", "{}", Some("g1")).unwrap();
        assert_eq!(d.parent_id, None);
        assert_eq!(d.source_id.as_deref(), Some("g1"));

        // 宿主不存在 → 报错
        let err = create(&conn, "d4", "w1", None, "x", "board", "{}", Some("ghost")).unwrap_err();
        assert!(err.contains("database view not found"), "{err}");
        // 派生视图不能再被派生（否则数据归属要递归解析）
        let err = create(&conn, "d5", "w1", None, "x", "board", "{}", Some("d1")).unwrap_err();
        assert!(err.contains("database view not found"), "{err}");
        // document 布局的派生视图没有意义（内容挂在 documents 上）
        let err = create(&conn, "d6", "w1", None, "x", "document", "{}", Some("g1")).unwrap_err();
        assert!(err.contains("document layout"), "{err}");
    }

    #[test]
    fn soft_delete_and_restore_cover_derived_views() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");

        soft_delete(&conn, "g1").unwrap();
        let (t, del): (i64, Option<i64>) = conn
            .query_row("SELECT is_trash, deleted_at FROM views WHERE id='d1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((t, del.is_some()), (1, true), "派生视图随宿主进回收站");

        restore(&conn, "g1").unwrap();
        let (t, del): (i64, Option<i64>) = conn
            .query_row("SELECT is_trash, deleted_at FROM views WHERE id='d1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((t, del.is_some()), (0, false), "恢复后派生视图回来且 deleted_at 清空");
    }

    #[test]
    fn purge_host_cascades_to_derived_views() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");
        purge(&conn, "g1").unwrap(); // views.source_id 的 FK ON DELETE CASCADE
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn move_renumber_ignores_derived_views() {
        let conn = setup();
        seed_default_fixture(&conn); // r1/r2/r3 根级 0..2
        derive(&conn, "d1", "r1", "看板", "board"); // parent_id 同为 NULL
        move_view(&conn, "r3", Some("r1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["r3"], (Some("r1".into()), 0));
        assert_eq!(l["r1"], (None, 0));
        assert_eq!(l["r2"], (None, 1));
        // 派生视图没被当成根级兄弟参与重排：仍是 NULL 父级、position 独立
        assert_eq!(l["d1"], (None, 0));
    }
}
