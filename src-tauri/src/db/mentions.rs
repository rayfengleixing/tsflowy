use rusqlite::{params, Connection};

use super::models::{BacklinkRow, MentionRowIn, ViewRow};
use super::{dberr, now_ms};

/// 单事务重建某文档的 mentions 行：先删 src 全部旧行，再整批写入。
/// 自引用过滤与 id 生成在 JS 侧完成（collectMentions / newId()）；updated_at 统一取本次调用时刻。
pub fn rebuild_for(conn: &Connection, view_id: &str, rows: &[MentionRowIn]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("rebuild mentions"))?;
    tx.execute("DELETE FROM mentions WHERE src_view_id = ?1", params![view_id])
        .map_err(dberr("rebuild mentions"))?;
    let t = now_ms();
    for row in rows {
        tx.execute(
            "INSERT INTO mentions(id, src_view_id, target_view_id, context_text, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row.id, view_id, row.target_view_id, row.context_text, t],
        )
        .map_err(dberr("rebuild mentions"))?;
    }
    tx.commit().map_err(dberr("rebuild mentions (commit)"))?;
    Ok(())
}

/// 反链查询：JOIN 带出完整来源视图行（EditorPage 反链面板直接用，替代旧 N+1 viewApi.get）。
pub fn list_backlinks(conn: &Connection, target_view_id: &str) -> Result<Vec<BacklinkRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.src_view_id, m.target_view_id, m.context_text, m.updated_at,
                    v.id AS v_id, v.workspace_id AS v_workspace_id, v.parent_id AS v_parent_id,
                    v.name AS v_name, v.icon AS v_icon, v.layout AS v_layout, v.extra AS v_extra,
                    v.position AS v_position, v.is_favorite AS v_is_favorite, v.is_trash AS v_is_trash,
                    v.deleted_at AS v_deleted_at, v.created_at AS v_created_at, v.updated_at AS v_updated_at,
                    v.visited_at AS v_visited_at, v.source_id AS v_source_id, v.tags AS v_tags
             FROM mentions m
             JOIN views v ON v.id = m.src_view_id
             WHERE m.target_view_id = ?1
             ORDER BY m.updated_at DESC",
        )
        .map_err(dberr("list backlinks"))?;
    let rows = stmt
        .query_map(params![target_view_id], |r| {
            Ok(BacklinkRow {
                id: r.get(0)?,
                src_view_id: r.get(1)?,
                target_view_id: r.get(2)?,
                context_text: r.get(3)?,
                updated_at: r.get(4)?,
                src_view: ViewRow {
                    id: r.get(5)?,
                    workspace_id: r.get(6)?,
                    parent_id: r.get(7)?,
                    name: r.get(8)?,
                    icon: r.get(9)?,
                    layout: r.get(10)?,
                    extra: r.get(11)?,
                    position: r.get(12)?,
                    is_favorite: r.get(13)?,
                    is_trash: r.get(14)?,
                    deleted_at: r.get(15)?,
                    created_at: r.get(16)?,
                    updated_at: r.get(17)?,
                    visited_at: r.get(18)?,
                    source_id: r.get(19)?,
                    tags: r.get(20)?,
                },
            })
        })
        .map_err(dberr("list backlinks"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list backlinks"))?;
    Ok(rows)
}

/// 启动回填判空用。
pub fn count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM mentions", [], |r| r.get(0))
        .map_err(dberr("count mentions"))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn seed_view(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', NULL, ?2, 'document', '{}', 0, 1, 1)",
            params![id, name],
        )
        .unwrap();
    }

    fn row(id: &str, target: &str) -> MentionRowIn {
        MentionRowIn {
            id: id.to_string(),
            target_view_id: target.to_string(),
            context_text: Some("上下文".to_string()),
        }
    }

    fn mention_count_for(conn: &Connection, src: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM mentions WHERE src_view_id = ?1",
            params![src],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn rebuild_replaces_previous_rows_idempotently() {
        let conn = setup();
        seed_view(&conn, "s", "源");
        seed_view(&conn, "t1", "目标1");
        seed_view(&conn, "t2", "目标2");

        rebuild_for(&conn, "s", &[row("m1", "t1")]).unwrap();
        assert_eq!(mention_count_for(&conn, "s"), 1);

        // 第二次重建覆盖旧行；同内容重复执行不产生重复行
        rebuild_for(&conn, "s", &[row("m2", "t2")]).unwrap();
        rebuild_for(&conn, "s", &[row("m2", "t2")]).unwrap();
        let targets: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT target_view_id FROM mentions WHERE src_view_id = 's'")
                .unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(targets, vec!["t2".to_string()]);
    }

    #[test]
    fn rebuild_rolls_back_on_fk_violation() {
        let conn = setup();
        seed_view(&conn, "s", "源");
        seed_view(&conn, "t1", "目标1");

        rebuild_for(&conn, "s", &[row("m1", "t1")]).unwrap();
        // 指向不存在 view 的行触发 FK → 整个事务回滚，旧行保持完整
        let err = rebuild_for(&conn, "s", &[row("m2", "t1"), row("m3", "ghost")]).unwrap_err();
        assert!(err.contains("FOREIGN KEY"), "{err}");
        assert_eq!(mention_count_for(&conn, "s"), 1);
    }

    #[test]
    fn backlinks_carry_source_view_and_order_desc() {
        let conn = setup();
        seed_view(&conn, "s1", "源文档一");
        seed_view(&conn, "s2", "源文档二");
        seed_view(&conn, "t", "被引用");

        let insert = |id: &str, src: &str, at: i64| {
            conn.execute(
                "INSERT INTO mentions(id, src_view_id, target_view_id, context_text, updated_at)
                 VALUES (?1, ?2, 't', NULL, ?3)",
                params![id, src, at],
            )
            .unwrap();
        };
        insert("m1", "s1", 100);
        insert("m2", "s2", 200);

        let rows = list_backlinks(&conn, "t").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "m2"); // updated_at 倒序
        assert_eq!(rows[1].id, "m1");
        assert_eq!(rows[0].src_view.name, "源文档二");
        assert_eq!(rows[1].src_view.name, "源文档一");
        assert_eq!(rows[0].src_view.id, "s2");
    }

    #[test]
    fn count_returns_total() {
        let conn = setup();
        seed_view(&conn, "s", "源");
        seed_view(&conn, "t1", "目标1");
        seed_view(&conn, "t2", "目标2");
        assert_eq!(count(&conn).unwrap(), 0);
        rebuild_for(&conn, "s", &[row("m1", "t1"), row("m2", "t2")]).unwrap();
        assert_eq!(count(&conn).unwrap(), 2);
    }

    // 自引用过滤（targetId === viewId 不入库）是 JS 侧职责，Rust 原样收行——见 mentions.ts rebuildFor
    #[test]
    fn delete_view_cascades_mention_rows_both_sides() {
        let conn = setup();
        seed_view(&conn, "s", "源");
        seed_view(&conn, "t", "目标");
        rebuild_for(&conn, "s", &[row("m1", "t")]).unwrap();

        conn.execute("DELETE FROM views WHERE id = 't'", []).unwrap();
        assert_eq!(count(&conn).unwrap(), 0);

        rebuild_for(&conn, "s", &[row("m2", "s")]).unwrap(); // 自引用行也受 FK 保护
        conn.execute("DELETE FROM views WHERE id = 's'", []).unwrap();
        assert_eq!(count(&conn).unwrap(), 0);
    }
}
