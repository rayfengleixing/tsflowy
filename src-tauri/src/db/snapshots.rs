use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::{dberr, now_ms};

/// 同一页面两次快照的最小间隔：编辑保存高频触发，无节流会瞬间写满。
pub const SNAPSHOT_INTERVAL_MS: i64 = 10 * 60 * 1000;
/// 每页保留的自动快照份数上限（restore 前的 pre_restore 备份不占额度）。
pub const SNAPSHOT_KEEP: i64 = 50;

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotRowOut {
    pub id: i64,
    pub view_id: String,
    pub reason: String,
    pub created_at: i64,
}

fn insert(conn: &Connection, view_id: &str, content: &str, reason: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO document_snapshots(view_id, content, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![view_id, content, reason, now_ms()],
    )
    .map_err(dberr("insert snapshot"))?;
    Ok(conn.last_insert_rowid())
}

/// 裁剪该页最旧的自动快照，保留最近 SNAPSHOT_KEEP 份。
fn trim(conn: &Connection, view_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM document_snapshots
         WHERE view_id = ?1 AND reason = 'auto'
           AND id NOT IN (
             SELECT id FROM document_snapshots WHERE view_id = ?1 AND reason = 'auto'
             ORDER BY id DESC LIMIT ?2
           )",
        params![view_id, SNAPSHOT_KEEP],
    )
    .map_err(dberr("trim snapshots"))?;
    Ok(())
}

/// 保存文档后调用：距该页最近一次快照（任意 reason）超过间隔才落新快照。
/// 刚做过 pre_restore 备份的页面同样会被节流，避免恢复后立刻又快照一份相同内容。
pub fn maybe_snapshot(conn: &Connection, view_id: &str, content: &str) -> Result<(), String> {
    // MAX 聚合空表时返回一行 NULL（不是零行），必须映射成 Option
    let last: Option<i64> = conn
        .query_row(
            "SELECT MAX(created_at) FROM document_snapshots WHERE view_id = ?1",
            params![view_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(dberr("read last snapshot"))?
        .flatten();
    if let Some(t) = last {
        if now_ms() - t < SNAPSHOT_INTERVAL_MS {
            return Ok(());
        }
    }
    insert(conn, view_id, content, "auto")?;
    trim(conn, view_id)
}

pub fn list(conn: &Connection, view_id: &str) -> Result<Vec<SnapshotRowOut>, String> {
    let mut stmt = conn
        .prepare("SELECT id, view_id, reason, created_at FROM document_snapshots WHERE view_id = ?1 ORDER BY id DESC")
        .map_err(dberr("list snapshots"))?;
    let rows = stmt
        .query_map(params![view_id], |r| {
            Ok(SnapshotRowOut {
                id: r.get(0)?,
                view_id: r.get(1)?,
                reason: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(dberr("list snapshots"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list snapshots"))?;
    Ok(rows)
}

/// 恢复快照：先把当前内容备份成 pre_restore（撤销恢复的退路），再写回 documents。
/// 写回走 db::docs::save 同一条 UPSERT，FTS 由触发器同步。
pub fn restore(conn: &Connection, id: i64) -> Result<String, String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT view_id, content FROM document_snapshots WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr("get snapshot"))?;
    let Some((view_id, content)) = row else {
        return Err(format!("snapshot not found: {id}"));
    };
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("restore snapshot"))?;
    if let Ok(Some(current)) = super::docs::get(&tx, &view_id) {
        insert(&tx, &view_id, &current, "pre_restore")?;
    }
    super::docs::save(&tx, &view_id, &content)?;
    tx.commit().map_err(dberr("restore snapshot (commit)"))?;
    Ok(view_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::views;

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

    fn seed_doc(conn: &Connection) {
        views::create(conn, "v1", "w1", None, "文档", "document", "{}", None).unwrap();
    }

    #[test]
    fn snapshot_is_throttled_by_interval() {
        let conn = setup();
        seed_doc(&conn);
        maybe_snapshot(&conn, "v1", r#"{"v":1}"#).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":2}"#).unwrap();
        assert_eq!(list(&conn, "v1").unwrap().len(), 1, "间隔内不重复快照");
    }

    #[test]
    fn restore_writes_back_and_keeps_pre_restore_backup() {
        let conn = setup();
        seed_doc(&conn);
        super::super::docs::save(&conn, "v1", r#"{"v":"old"}"#).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":"old"}"#).unwrap();
        // 等价于修改后保存
        super::super::docs::save(&conn, "v1", r#"{"v":"new"}"#).unwrap();

        let snap_id = list(&conn, "v1").unwrap()[0].id;
        let vid = restore(&conn, snap_id).unwrap();
        assert_eq!(vid, "v1");
        assert_eq!(
            super::super::docs::get(&conn, "v1").unwrap().unwrap(),
            r#"{"v":"old"}"#
        );

        let rows = list(&conn, "v1").unwrap();
        assert!(rows.iter().any(|r| r.reason == "pre_restore"), "恢复前先备份当前版本");
    }

    #[test]
    fn trim_keeps_recent_snapshots() {
        let conn = setup();
        seed_doc(&conn);
        for i in 0..(SNAPSHOT_KEEP + 5) {
            conn.execute(
                "INSERT INTO document_snapshots(view_id, content, reason, created_at) VALUES ('v1', ?1, 'auto', ?2)",
                params![format!("{{\"v\":{i}}}"), 1000 + i * SNAPSHOT_INTERVAL_MS],
            )
            .unwrap();
        }
        trim(&conn, "v1").unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_snapshots WHERE view_id = 'v1' AND reason = 'auto'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, SNAPSHOT_KEEP);
    }

    #[test]
    fn restore_missing_snapshot_fails_cleanly() {
        let conn = setup();
        let err = restore(&conn, 999).unwrap_err();
        assert!(err.contains("snapshot not found"), "{err}");
    }

    #[test]
    fn purging_view_removes_snapshots_via_trigger() {
        let conn = setup();
        seed_doc(&conn);
        maybe_snapshot(&conn, "v1", "{}").unwrap();
        views::soft_delete(&conn, "v1").unwrap();
        assert_eq!(list(&conn, "v1").unwrap().len(), 1, "软删不清快照（可恢复）");
        views::purge(&conn, "v1").unwrap();
        assert_eq!(list(&conn, "v1").unwrap().len(), 0, "硬删由触发器清理快照");
    }
}
