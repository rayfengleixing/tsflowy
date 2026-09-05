use rusqlite::{params, Connection, OptionalExtension};

use super::models::PagePropertyOut;
use super::dberr;

fn row_to_pp(r: &rusqlite::Row<'_>) -> rusqlite::Result<PagePropertyOut> {
    Ok(PagePropertyOut {
        view_id: r.get("view_id")?,
        key: r.get("key")?,
        value: r.get("value")?,
        field_type: r.get("field_type")?,
        position: r.get("position")?,
    })
}

/// view 全部属性，按 position ASC（与旧 page-properties.ts list 同序）。
pub fn list(conn: &Connection, view_id: &str) -> Result<Vec<PagePropertyOut>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM page_properties WHERE view_id = ?1 ORDER BY position ASC")
        .map_err(dberr("list page properties"))?;
    let rows = stmt
        .query_map(params![view_id], row_to_pp)
        .map_err(dberr("list page properties"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list page properties"))?;
    Ok(rows)
}

/// 存在则只更新 value/field_type（保留 position）；不存在则 MAX+1 插入。
/// 与旧实现一致：两步不做事务（单写连接下无并发窗口）。
pub fn set(conn: &Connection, view_id: &str, key: &str, value: &str, field_type: &str) -> Result<(), String> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT position FROM page_properties WHERE view_id = ?1 AND key = ?2",
            params![view_id, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr("set page property"))?;
    if existing.is_some() {
        conn.execute(
            "UPDATE page_properties SET value = ?1, field_type = ?2 WHERE view_id = ?3 AND key = ?4",
            params![value, field_type, view_id, key],
        )
        .map_err(dberr("set page property"))?;
    } else {
        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM page_properties WHERE view_id = ?1",
                params![view_id],
                |r| r.get(0),
            )
            .map_err(dberr("set page property"))?;
        conn.execute(
            "INSERT INTO page_properties(view_id, key, value, field_type, position) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(view_id, key) DO UPDATE SET value = excluded.value, field_type = excluded.field_type",
            params![view_id, key, value, field_type, position],
        )
        .map_err(dberr("set page property"))?;
    }
    Ok(())
}

/// 原样移植旧实现的 position 紧凑查询：DELETE 后子查询已查不到该行 →
/// COALESCE 落到 -1 → 该 view **全部**行 position-1。属历史行为（UI 顺序仍稳定），本阶段不修。
pub fn remove(conn: &Connection, view_id: &str, key: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM page_properties WHERE view_id = ?1 AND key = ?2",
        params![view_id, key],
    )
    .map_err(dberr("remove page property"))?;
    conn.execute(
        "UPDATE page_properties SET position = position - 1 WHERE view_id = ?1 AND position > (
           SELECT COALESCE((SELECT position FROM page_properties WHERE view_id = ?1 AND key = ?2), -1)
         )",
        params![view_id, key],
    )
    .map_err(dberr("remove page property"))?;
    Ok(())
}

/// 重命名（JS 侧已拦截 !newKey.trim() || oldKey === newKey）。
/// 与旧实现逐字一致：冲突检查用**未 trim** 的 newKey，落库更新用 trim 后的值；
/// 目标已存在时语义为"删旧留目标"（合并）。
pub fn rename(conn: &Connection, view_id: &str, old_key: &str, new_key: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("rename page property"))?;
    let target_exists = tx
        .query_row(
            "SELECT 1 FROM page_properties WHERE view_id = ?1 AND key = ?2",
            params![view_id, new_key],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(dberr("rename page property"))?
        .is_some();
    if target_exists {
        tx.execute(
            "DELETE FROM page_properties WHERE view_id = ?1 AND key = ?2",
            params![view_id, old_key],
        )
        .map_err(dberr("rename page property"))?;
    } else {
        tx.execute(
            "UPDATE page_properties SET key = ?1 WHERE view_id = ?2 AND key = ?3",
            params![new_key.trim(), view_id, old_key],
        )
        .map_err(dberr("rename page property"))?;
    }
    tx.commit().map_err(dberr("rename page property (commit)"))?;
    Ok(())
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
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1', 'w1', NULL, '文档', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn keys_positions(conn: &Connection) -> Vec<(String, i64)> {
        let mut stmt = conn
            .prepare("SELECT key, position FROM page_properties WHERE view_id = 'v1' ORDER BY key")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn set_existing_updates_value_type_keeping_position() {
        let conn = setup();
        set(&conn, "v1", "状态", "todo", "single_select").unwrap();
        set(&conn, "v1", "状态", "done", "checkbox").unwrap();
        let rows = list(&conn, "v1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value, "done");
        assert_eq!(rows[0].field_type, "checkbox");
        assert_eq!(rows[0].position, 0);
    }

    #[test]
    fn set_new_keys_get_incrementing_positions() {
        let conn = setup();
        set(&conn, "v1", "a", "1", "text").unwrap();
        set(&conn, "v1", "b", "2", "text").unwrap();
        set(&conn, "v1", "c", "3", "text").unwrap();
        assert_eq!(
            keys_positions(&conn),
            vec![
                ("a".to_string(), 0),
                ("b".to_string(), 1),
                ("c".to_string(), 2)
            ]
        );
    }

    #[test]
    fn list_orders_by_position() {
        let conn = setup();
        set(&conn, "v1", "b", "1", "text").unwrap();
        set(&conn, "v1", "a", "2", "text").unwrap();
        let rows = list(&conn, "v1").unwrap();
        assert_eq!(rows[0].key, "b");
        assert_eq!(rows[1].key, "a");
    }

    #[test]
    fn remove_decrements_all_remaining_positions_historical_behavior() {
        let conn = setup();
        set(&conn, "v1", "k0", "0", "text").unwrap();
        set(&conn, "v1", "k1", "1", "text").unwrap();
        set(&conn, "v1", "k2", "2", "text").unwrap();

        remove(&conn, "v1", "k1").unwrap();
        // 历史行为锁死：DELETE 后子查询为 NULL → COALESCE -1 → 全部剩余行 -1（k0: -1, k2: 1）
        assert_eq!(
            keys_positions(&conn),
            vec![("k0".to_string(), -1), ("k2".to_string(), 1)]
        );
    }

    #[test]
    fn remove_missing_key_still_decrements_everything() {
        let conn = setup();
        set(&conn, "v1", "a", "0", "text").unwrap();
        set(&conn, "v1", "b", "1", "text").unwrap();
        remove(&conn, "v1", "ghost").unwrap();
        // 同上一致的历史行为：目标不存在时全部行也会被减 1
        assert_eq!(
            keys_positions(&conn),
            vec![("a".to_string(), -1), ("b".to_string(), 0)]
        );
    }

    #[test]
    fn rename_to_fresh_key_trims_on_write() {
        let conn = setup();
        set(&conn, "v1", "a", "va", "text").unwrap();
        // 冲突检查用未 trim 的 "b "（无命中）→ 更新用 trim 后的 "b"
        rename(&conn, "v1", "a", "b ").unwrap();
        let rows = list(&conn, "v1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "b");
        assert_eq!(rows[0].value, "va");
        assert_eq!(rows[0].position, 0);
    }

    #[test]
    fn rename_to_existing_key_deletes_old_keeps_target() {
        let conn = setup();
        set(&conn, "v1", "a", "va", "text").unwrap();
        set(&conn, "v1", "b", "vb", "date").unwrap();
        rename(&conn, "v1", "a", "b").unwrap();
        let rows = list(&conn, "v1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "b");
        assert_eq!(rows[0].value, "vb"); // 目标优先，不被旧值覆盖
        assert_eq!(rows[0].position, 1);
    }

    #[test]
    fn delete_view_cascades_properties() {
        let conn = setup();
        set(&conn, "v1", "a", "1", "text").unwrap();
        conn.execute("DELETE FROM views WHERE id = 'v1'", []).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM page_properties", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
