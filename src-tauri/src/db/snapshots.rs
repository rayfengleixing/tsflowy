use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::{dberr, now_ms};

/// 同一页面两次快照的最小间隔（默认值）：编辑保存高频触发，无节流会瞬间写满。
pub const SNAPSHOT_INTERVAL_MINUTES_DEFAULT: u64 = 10;
/// 每页保留的自动快照份数（默认值）。
pub const SNAPSHOT_KEEP_DEFAULT: u64 = 50;
/// restore 前的 pre_restore 备份不占自动快照额度，但也要有上限，否则反复恢复会无界增长。
pub const PRE_RESTORE_KEEP_DEFAULT: u64 = 5;

/// 快照策略参数：由应用配置（commands::files::config::SnapshotConfig）注入，
/// 默认值与历史上写死的常量一致。
#[derive(Debug, Clone, Copy)]
pub struct SnapshotPolicy {
    /// 同一页面两次快照的最小间隔（毫秒）
    pub interval_ms: i64,
    /// 每页保留的自动快照份数
    pub keep: i64,
    /// 每页保留的 pre_restore 备份份数
    pub pre_restore_keep: i64,
}

impl Default for SnapshotPolicy {
    fn default() -> Self {
        Self {
            interval_ms: SNAPSHOT_INTERVAL_MINUTES_DEFAULT as i64 * 60 * 1000,
            keep: SNAPSHOT_KEEP_DEFAULT as i64,
            pre_restore_keep: PRE_RESTORE_KEEP_DEFAULT as i64,
        }
    }
}

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

/// 裁剪该页某一 reason 的最旧快照，保留最近 keep 份。
fn trim_by_reason(conn: &Connection, view_id: &str, reason: &str, keep: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM document_snapshots
         WHERE view_id = ?1 AND reason = ?2
           AND id NOT IN (
             SELECT id FROM document_snapshots WHERE view_id = ?1 AND reason = ?2
             ORDER BY id DESC LIMIT ?3
           )",
        params![view_id, reason, keep],
    )
    .map_err(dberr("trim snapshots"))?;
    Ok(())
}

/// 保存文档后调用：距该页最近一次快照（任意 reason）超过间隔才落新快照。
/// 刚做过 pre_restore 备份的页面同样会被节流，避免恢复后立刻又快照一份相同内容。
pub fn maybe_snapshot(
    conn: &Connection,
    view_id: &str,
    content: &str,
    policy: &SnapshotPolicy,
) -> Result<(), String> {
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
        if now_ms() - t < policy.interval_ms {
            return Ok(());
        }
    }
    insert(conn, view_id, content, "auto")?;
    trim_by_reason(conn, view_id, "auto", policy.keep)
}

/// 取单份快照的正文（历史版本对比用）。列表只回元数据，正文按需单独取，
/// 否则一次打开历史面板就要把几十份全文搬过 IPC。
pub fn content(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT content FROM document_snapshots WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(dberr("get snapshot content"))
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
pub fn restore(conn: &Connection, id: i64, policy: &SnapshotPolicy) -> Result<String, String> {
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
        trim_by_reason(&tx, &view_id, "pre_restore", policy.pre_restore_keep)?;
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
        views::create(
            conn,
            views::NewView {
                id: "v1",
                workspace_id: "w1",
                parent_id: None,
                name: "文档",
                layout: "document",
                extra: "{}",
                source_id: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn default_policy_matches_the_original_hardcoded_values() {
        let p = SnapshotPolicy::default();
        assert_eq!(p.interval_ms, 10 * 60 * 1000);
        assert_eq!(p.keep, 50);
        assert_eq!(p.pre_restore_keep, 5);
    }

    #[test]
    fn snapshot_is_throttled_by_interval() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy::default();
        maybe_snapshot(&conn, "v1", r#"{"v":1}"#, &policy).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":2}"#, &policy).unwrap();
        assert_eq!(list(&conn, "v1").unwrap().len(), 1, "间隔内不重复快照");
    }

    #[test]
    fn shorter_interval_lands_more_snapshots() {
        let conn = setup();
        seed_doc(&conn);
        // 间隔 0 分钟（1 分钟是配置下限，这里只验证参数确实生效）
        let policy = SnapshotPolicy {
            interval_ms: 0,
            keep: 50,
            pre_restore_keep: 5,
        };
        maybe_snapshot(&conn, "v1", r#"{"v":1}"#, &policy).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":2}"#, &policy).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":3}"#, &policy).unwrap();
        assert_eq!(list(&conn, "v1").unwrap().len(), 3, "间隔内不限就不节流");
    }

    #[test]
    fn auto_snapshots_are_trimmed_to_policy_keep() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy {
            interval_ms: 0,
            keep: 3,
            pre_restore_keep: 5,
        };
        for i in 0..6 {
            maybe_snapshot(&conn, "v1", &format!(r#"{{"v":{i}}}"#), &policy).unwrap();
        }
        let rows = list(&conn, "v1").unwrap();
        let autos: Vec<i64> = rows
            .iter()
            .filter(|r| r.reason == "auto")
            .map(|r| r.id)
            .collect();
        assert_eq!(autos.len(), 3, "只保留策略设定的份数");
        assert_eq!(autos, vec![6, 5, 4], "裁掉最旧的三份，留下最近的");
    }

    #[test]
    fn restore_writes_back_and_keeps_pre_restore_backup() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy::default();
        super::super::docs::save(&conn, "v1", r#"{"v":"old"}"#).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":"old"}"#, &policy).unwrap();
        // 等价于修改后保存
        super::super::docs::save(&conn, "v1", r#"{"v":"new"}"#).unwrap();

        let snap_id = list(&conn, "v1").unwrap()[0].id;
        let vid = restore(&conn, snap_id, &policy).unwrap();
        assert_eq!(vid, "v1");
        assert_eq!(
            super::super::docs::get(&conn, "v1").unwrap().unwrap(),
            r#"{"v":"old"}"#
        );

        let rows = list(&conn, "v1").unwrap();
        assert!(
            rows.iter().any(|r| r.reason == "pre_restore"),
            "恢复前先备份当前版本"
        );
    }

    #[test]
    fn pre_restore_backups_are_bounded() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy {
            interval_ms: 0,
            keep: 50,
            pre_restore_keep: 2,
        };
        super::super::docs::save(&conn, "v1", r#"{"v":"seed"}"#).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":"seed"}"#, &policy).unwrap();
        let snap_id = list(&conn, "v1").unwrap()[0].id;
        for i in 0..8 {
            super::super::docs::save(&conn, "v1", &format!(r#"{{"v":{i}}}"#)).unwrap();
            restore(&conn, snap_id, &policy).unwrap();
        }
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_snapshots WHERE view_id = 'v1' AND reason = 'pre_restore'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            n, policy.pre_restore_keep,
            "pre_restore 只保留策略设定的份数"
        );
    }

    #[test]
    fn trim_keeps_recent_snapshots() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy::default();
        for i in 0..(SNAPSHOT_KEEP_DEFAULT as i64 + 5) {
            conn.execute(
                "INSERT INTO document_snapshots(view_id, content, reason, created_at) VALUES ('v1', ?1, 'auto', ?2)",
                params![format!("{{\"v\":{i}}}"), 1000 + i * policy.interval_ms],
            )
            .unwrap();
        }
        trim_by_reason(&conn, "v1", "auto", policy.keep).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_snapshots WHERE view_id = 'v1' AND reason = 'auto'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, SNAPSHOT_KEEP_DEFAULT as i64);
    }

    #[test]
    fn restore_missing_snapshot_fails_cleanly() {
        let conn = setup();
        let err = restore(&conn, 999, &SnapshotPolicy::default()).unwrap_err();
        assert!(err.contains("snapshot not found"), "{err}");
    }

    #[test]
    fn content_reads_one_snapshot_by_id() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy {
            interval_ms: 0,
            ..SnapshotPolicy::default()
        };
        maybe_snapshot(&conn, "v1", r#"{"v":1}"#, &policy).unwrap();
        maybe_snapshot(&conn, "v1", r#"{"v":2}"#, &policy).unwrap();
        let rows = list(&conn, "v1").unwrap();
        assert_eq!(
            content(&conn, rows[0].id).unwrap().as_deref(),
            Some(r#"{"v":2}"#)
        );
        assert_eq!(
            content(&conn, rows[1].id).unwrap().as_deref(),
            Some(r#"{"v":1}"#)
        );
        // 不存在的 id 回 None，不是错误：前端要能区分「没这份」和「库读不动」
        assert_eq!(content(&conn, 999).unwrap(), None);
    }

    #[test]
    fn purging_view_removes_snapshots_via_trigger() {
        let conn = setup();
        seed_doc(&conn);
        let policy = SnapshotPolicy::default();
        maybe_snapshot(&conn, "v1", "{}", &policy).unwrap();
        views::soft_delete(&conn, "v1").unwrap();
        assert_eq!(
            list(&conn, "v1").unwrap().len(),
            1,
            "软删不清快照（可恢复）"
        );
        views::purge(&conn, "v1").unwrap();
        assert_eq!(list(&conn, "v1").unwrap().len(), 0, "硬删由触发器清理快照");
    }
}
