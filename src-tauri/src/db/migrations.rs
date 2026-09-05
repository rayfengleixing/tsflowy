/// 迁移运行器：自管 `schema_migrations` 表。
/// 存量安装（tauri-plugin-sql 时代）通过检测 `_sqlx_migrations` 做基线，不重跑 001-006；
/// 全新安装依序应用全部迁移。每个迁移与其版本行在同一事务内原子提交。
pub struct Migration {
    pub version: i64,
    pub description: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "init",
        sql: include_str!("../../../migrations/001_init.sql"),
    },
    Migration {
        version: 2,
        description: "created_edited_triggers",
        sql: include_str!("../../../migrations/002_created_edited_triggers.sql"),
    },
    Migration {
        version: 3,
        description: "mentions_index",
        sql: include_str!("../../../migrations/003_mentions.sql"),
    },
    Migration {
        version: 4,
        description: "visited_at",
        sql: include_str!("../../../migrations/004_visited_at.sql"),
    },
    Migration {
        version: 5,
        description: "page_properties",
        sql: include_str!("../../../migrations/005_page_properties.sql"),
    },
    Migration {
        version: 6,
        description: "composite_indexes",
        sql: include_str!("../../../migrations/006_composite_indexes.sql"),
    },
];

pub fn ensure_migrated(conn: &rusqlite::Connection) -> Result<(), String> {
    ensure_migrated_with(conn, MIGRATIONS)?;
    ensure_sqlx_compat(conn)
}

/// 全新安装兼容：A–C 阶段 tauri-plugin-sql 仍负责 documents/mentions 等路径，
/// 它首次 Database.load 时会按 `_sqlx_migrations` 逐版本校验 checksum（SHA384(sql 字节)）。
/// 我们抢先迁移后若不补写该表，插件会对已存在的表重复 CREATE TABLE 直接报错。
/// 因此对"我们已应用、_sqlx_migrations 缺席"的版本补写等价行（checksum 与插件同源，
/// 均为 include_str! 文件字节的 SHA384）。存量安装该表已存在 → 只读不写。
fn ensure_sqlx_compat(conn: &rusqlite::Connection) -> Result<(), String> {
    use sha2::{Digest, Sha384};

    let has_sqlx: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("check _sqlx_migrations: {e}"))?;
    if has_sqlx > 0 {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
           version BIGINT PRIMARY KEY,
           description TEXT NOT NULL,
           installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
           success BOOLEAN NOT NULL,
           checksum BLOB NOT NULL,
           execution_time BIGINT NOT NULL
         );",
    )
    .map_err(|e| format!("create _sqlx_migrations: {e}"))?;
    for m in MIGRATIONS {
        let applied: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                [m.version],
                |r| r.get(0),
            )
            .map_err(|e| format!("read schema_migrations: {e}"))?;
        if applied == 0 {
            continue;
        }
        let checksum = Sha384::digest(m.sql.as_bytes());
        conn.execute(
            "INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time)
             VALUES (?1, ?2, TRUE, ?3, 0)",
            rusqlite::params![m.version, m.description, checksum.as_slice()],
        )
        .map_err(|e| format!("seed _sqlx_migrations {}: {e}", m.version))?;
    }
    tracing::info!("seeded _sqlx_migrations for tauri-plugin-sql coexistence");
    Ok(())
}

pub fn ensure_migrated_with(conn: &rusqlite::Connection, migrations: &[Migration]) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           description TEXT NOT NULL,
           applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| format!("create schema_migrations: {e}"))?;
    seed_sqlx_baseline(conn)?;

    for m in migrations {
        let applied: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                [m.version],
                |r| r.get(0),
            )
            .map_err(|e| format!("read schema_migrations: {e}"))?;
        if applied > 0 {
            continue;
        }
        if let Err(e) = apply_one(conn, m) {
            // 版本行与 DDL 同事务：失败即整体回滚，schema 保持未应用状态，下次启动干净重试
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(format!("migration {} ({}): {e}", m.version, m.description));
        }
        tracing::info!(version = m.version, description = m.description, "migration applied");
    }
    Ok(())
}

fn apply_one(conn: &rusqlite::Connection, m: &Migration) -> rusqlite::Result<()> {
    let batch = format!(
        "BEGIN IMMEDIATE;\n{}\nINSERT INTO schema_migrations(version, description, applied_at) VALUES ({}, '{}', {});\nCOMMIT;",
        m.sql, m.version, m.description, super::now_ms()
    );
    conn.execute_batch(&batch)
}

/// 存量安装基线：库里已有 sqlx 的 `_sqlx_migrations` 且我们的表为空 → 把已应用版本搬进来。
/// 双表并存时以我们的表为准（sqlx 表从此成为惰性遗留，不写不删）。
fn seed_sqlx_baseline(conn: &rusqlite::Connection) -> Result<(), String> {
    let has_sqlx: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("check _sqlx_migrations: {e}"))?;
    if has_sqlx == 0 {
        return Ok(());
    }
    let ours: i64 = conn
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
        .map_err(|e| format!("count schema_migrations: {e}"))?;
    if ours > 0 {
        return Ok(());
    }
    conn.execute_batch(
        "BEGIN IMMEDIATE;
         INSERT INTO schema_migrations(version, description, applied_at)
         SELECT version, 'sqlx baseline', CAST(strftime('%s','now') AS INTEGER) * 1000
         FROM _sqlx_migrations ORDER BY version;
         COMMIT;",
    )
    .map_err(|e| format!("seed baseline from _sqlx_migrations: {e}"))?;
    tracing::info!("seeded schema_migrations from _sqlx_migrations baseline");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use sha2::{Digest, Sha384};

    #[test]
    fn fresh_applies_all() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_migrated(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
        // 关键表都存在（也证明 bundled rusqlite 支持 FTS5 trigram）
        for t in ["workspaces", "views", "documents", "documents_fts", "page_properties", "mentions", "app_settings"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "table {t} missing");
        }
    }

    #[test]
    fn idempotent_reentry() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_migrated(&conn).unwrap();
        ensure_migrated(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
    }

    /// 建与 sqlx-sqlite 相同结构的 _sqlx_migrations（模拟存量安装的记账表）
    fn create_sqlx_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (
               version BIGINT PRIMARY KEY,
               description TEXT NOT NULL,
               installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
               success BOOLEAN NOT NULL,
               checksum BLOB NOT NULL,
               execution_time BIGINT NOT NULL
             );",
        )
        .unwrap();
    }

    fn record_sqlx_migration(conn: &Connection, m: &Migration) {
        conn.execute(
            "INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time)
             VALUES (?1, ?2, TRUE, x'AB', 0)",
            rusqlite::params![m.version, m.description],
        )
        .unwrap();
    }

    #[test]
    fn baseline_seeds_from_sqlx_table_without_reapplying() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟存量库：手动应用全部迁移 SQL + 建 _sqlx_migrations 记账表
        create_sqlx_table(&conn);
        for m in MIGRATIONS {
            conn.execute_batch(m.sql).unwrap();
            record_sqlx_migration(&conn, m);
        }
        ensure_migrated(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
        // 若发生重复应用，001 的裸 CREATE TABLE 会让 ensure_migrated 报错 —— 上面 unwrap 已证明未发生
    }

    /// 模拟 tauri-plugin-sql 首次 Database.load 的校验路径：
    /// 读 _sqlx_migrations 的 (version, checksum)，逐行与 SHA384(迁移文件字节) 对账。
    fn assert_plugin_validation_passes(conn: &Connection) {
        let mut stmt = conn
            .prepare("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .unwrap();
        let rows: Vec<(i64, Vec<u8>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), MIGRATIONS.len(), "plugin sees all versions");
        for (i, (version, checksum)) in rows.iter().enumerate() {
            assert_eq!(*version, MIGRATIONS[i].version);
            assert_eq!(
                checksum,
                &Sha384::digest(MIGRATIONS[i].sql.as_bytes()).to_vec(),
                "checksum mismatch for version {version}"
            );
        }
    }

    #[test]
    fn fresh_install_seeds_sqlx_rows_the_plugin_will_validate() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_migrated(&conn).unwrap();
        assert_plugin_validation_passes(&conn);
    }

    #[test]
    fn existing_sqlx_table_is_never_rewritten() {
        let conn = Connection::open_in_memory().unwrap();
        create_sqlx_table(&conn);
        for m in MIGRATIONS {
            conn.execute_batch(m.sql).unwrap();
            record_sqlx_migration(&conn, m);
        }
        ensure_migrated(&conn).unwrap();
        // 插件表的行保持原样：不产生 6+N 重复行，占位 checksum 也未被改写
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM _sqlx_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
        let (desc, checksum): (String, Vec<u8>) = conn
            .query_row(
                "SELECT description, checksum FROM _sqlx_migrations WHERE version = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(desc, MIGRATIONS[0].description);
        assert_eq!(checksum, vec![0xAB]);
    }

    #[test]
    fn failure_rolls_back_and_connection_stays_usable() {
        let conn = Connection::open_in_memory().unwrap();
        let bad = [
            Migration { version: 1, description: "ok", sql: "CREATE TABLE t1(a);" },
            Migration { version: 2, description: "bad", sql: "CREATE TABLE t2(a); NOT VALID SQL HERE;" },
        ];
        let err = ensure_migrated_with(&conn, &bad).unwrap_err();
        assert!(err.contains("migration 2"), "{err}");
        // 事务回滚：t2 不存在，t1 已提交；连接仍可用
        let t2: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 't2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(t2, 0);
        ensure_migrated_with(
            &conn,
            &[Migration { version: 1, description: "ok", sql: "CREATE TABLE t1(a);" }],
        )
        .unwrap();
    }
}
