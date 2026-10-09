/// 迁移运行器：自管 `schema_migrations` 表。
/// 存量安装（tauri-plugin-sql 时代）通过 `_sqlx_migrations` 做一次性基线导入（只读），
/// 此后该表成为惰性遗留；全新安装直接依序应用全部迁移。每个迁移与其版本行在同一事务内原子提交。
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
    Migration {
        version: 7,
        description: "multi_views",
        sql: include_str!("../../../migrations/007_multi_views.sql"),
    },
    Migration {
        version: 8,
        description: "database_cells_fts",
        sql: include_str!("../../../migrations/008_database_cells_fts.sql"),
    },
    Migration {
        version: 9,
        description: "tags_and_snapshots",
        sql: include_str!("../../../migrations/009_tags_and_snapshots.sql"),
    },
    Migration {
        version: 10,
        description: "documents_plain_text_fts",
        sql: include_str!("../../../migrations/010_documents_plain_text_fts.sql"),
    },
    Migration {
        version: 11,
        description: "database_fts_rowid",
        sql: include_str!("../../../migrations/011_database_fts_rowid.sql"),
    },
    Migration {
        version: 12,
        description: "database_fields_check",
        sql: include_str!("../../../migrations/012_database_fields_check.sql"),
    },
    Migration {
        version: 13,
        description: "database_fields_check_relations",
        sql: include_str!("../../../migrations/013_database_fields_check_relations.sql"),
    },
    Migration {
        version: 14,
        description: "views_layout_timeline",
        sql: include_str!("../../../migrations/014_views_layout_timeline.sql"),
    },
    Migration {
        version: 15,
        description: "database_fields_check_lightweight",
        sql: include_str!("../../../migrations/015_database_fields_check_lightweight.sql"),
    },
];

/// 自带事务的迁移：重建表改 CHECK 约束需要两个连接级 PRAGMA，而它们在事务内是 no-op，
/// 所以这类迁移由运行器在事务外设置、跑完恢复，SQL 自己 BEGIN/COMMIT：
///   - foreign_keys=OFF：DROP TABLE 在 FK 开启时会执行隐式 DELETE，经 ON DELETE CASCADE
///     把子表数据一并清空；
///   - legacy_alter_table=ON：RENAME 默认会重解析整个 schema 以改写其它对象里的引用，
///     而此刻旧表已删、其它触发器仍引用它，重解析会报 "no such table"。
const OWN_TRANSACTION_VERSIONS: &[i64] = &[12, 13, 14, 15];

pub fn ensure_migrated(conn: &rusqlite::Connection) -> Result<(), String> {
    ensure_migrated_with(conn, MIGRATIONS)
}

pub fn ensure_migrated_with(
    conn: &rusqlite::Connection,
    migrations: &[Migration],
) -> Result<(), String> {
    use rusqlite::OptionalExtension;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           description TEXT NOT NULL,
           applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| format!("create schema_migrations: {e}"))?;
    ensure_checksum_column(conn)?;
    seed_sqlx_baseline(conn)?;

    for m in migrations {
        let checksum = migration_checksum(m.sql);
        let stored: Option<Option<String>> = conn
            .query_row(
                "SELECT checksum FROM schema_migrations WHERE version = ?1",
                [m.version],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("read schema_migrations: {e}"))?;
        match stored {
            None => {
                let applied = if OWN_TRANSACTION_VERSIONS.contains(&m.version) {
                    apply_one_owning_transaction(conn, m, &checksum)
                } else {
                    apply_one(conn, m, &checksum)
                };
                if let Err(e) = applied {
                    // 版本行与 DDL 同事务：失败即整体回滚，schema 保持未应用状态，下次启动干净重试
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("migration {} ({}): {e}", m.version, m.description));
                }
                tracing::info!(
                    version = m.version,
                    description = m.description,
                    "migration applied"
                );
            }
            // 老库补写：此前没有指纹列，用当前文件字节回填，此后的改动才可检测
            Some(None) => {
                conn.execute(
                    "UPDATE schema_migrations SET checksum = ?1 WHERE version = ?2 AND checksum IS NULL",
                    rusqlite::params![checksum, m.version],
                )
                .map_err(|e| format!("backfill checksum {}: {e}", m.version))?;
            }
            Some(Some(recorded)) if recorded != checksum => {
                // 不阻断启动：库里数据是完整的，只是文件内容与当初应用的不一致（改过已发布的迁移）
                tracing::error!(
                    version = m.version,
                    description = m.description,
                    "migration file changed after being applied; schema may differ from a fresh install"
                );
            }
            Some(Some(_)) => {}
        }
    }
    Ok(())
}

/// schema_migrations 的内容指纹：迁移 SQL 的 SHA384 十六进制。
/// 只按 version 判重时，改过的迁移文件对已应用的库静默不生效（新装库却是新 schema），
/// 指纹让这种偏差在启动日志里现形（对齐 sqlx 的 checksum 契约，同源为文件字节）。
fn migration_checksum(sql: &str) -> String {
    use sha2::{Digest, Sha384};
    Sha384::digest(sql.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 老库的 schema_migrations 建表时没有 checksum 列，这里幂等补列（SQLite 无 IF NOT EXISTS 加列语法）
fn ensure_checksum_column(conn: &rusqlite::Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(schema_migrations)")
        .map_err(|e| format!("inspect schema_migrations: {e}"))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("inspect schema_migrations: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("inspect schema_migrations: {e}"))?;
    if cols.iter().any(|c| c == "checksum") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;")
        .map_err(|e| format!("add schema_migrations.checksum: {e}"))
}

fn apply_one(conn: &rusqlite::Connection, m: &Migration, checksum: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&migration_batch(m, checksum))
}

/// 版本行与 DDL 同事务提交：任一步失败则整体回滚，schema 与记账表保持一致。
fn migration_batch(m: &Migration, checksum: &str) -> String {
    format!(
        "BEGIN IMMEDIATE;\n{}\nINSERT INTO schema_migrations(version, description, applied_at, checksum) VALUES ({}, '{}', {}, '{}');\nCOMMIT;",
        m.sql, m.version, m.description, super::now_ms(), checksum
    )
}

/// 自带事务的迁移：事务外先关 FK / 打开 legacy rename（PRAGMA 在事务内是 no-op），
/// 跑完无论如何都恢复。失败时先 ROLLBACK 再恢复，避免留下开着的事务让后续 PRAGMA 静默失效。
fn apply_one_owning_transaction(
    conn: &rusqlite::Connection,
    m: &Migration,
    checksum: &str,
) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;")?;
    let result = conn.execute_batch(&migration_batch(m, checksum));
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK;");
    }
    let restore = conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF;");
    result.and(restore)
}

/// 存量安装一次性基线：库里已有 sqlx 的 `_sqlx_migrations` 且我们的表为空 → 把已应用版本搬进来，
/// 避免对存量库重跑建表迁移。只读该表，不写不删（tauri-plugin-sql 已移除，它只是历史记账）。
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

    #[test]
    fn fresh_applies_all() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_migrated(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
        // 关键表都存在（也证明 bundled rusqlite 支持 FTS5 trigram）
        for t in [
            "workspaces",
            "views",
            "documents",
            "documents_fts",
            "page_properties",
            "mentions",
            "app_settings",
            "database_fts",
            "database_cell_text",
        ] {
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

    #[test]
    fn applied_migrations_record_checksums_and_detect_drift() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_migrated(&conn).unwrap();
        // 应用时写入指纹：全部非空且与文件字节一致
        let nulls: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE checksum IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(nulls, 0);
        let recorded: String = conn
            .query_row(
                "SELECT checksum FROM schema_migrations WHERE version = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recorded, migration_checksum(MIGRATIONS[0].sql));

        // 文件被改过（库里指纹与当前文件不符）→ 启动不报错（数据完好），但偏差可被检出
        conn.execute(
            "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 2",
            [],
        )
        .unwrap();
        ensure_migrated(&conn).unwrap();
        let stale: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE checksum = 'deadbeef'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 1, "指纹不被回填覆盖（否则偏差永远检不出）");
    }

    #[test]
    fn legacy_table_without_checksum_column_is_backfilled_once() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟升级前的库：老结构的 schema_migrations + 已应用全部迁移
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               description TEXT NOT NULL,
               applied_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        for m in MIGRATIONS {
            apply_raw(&conn, m);
            conn.execute(
                "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, ?2, 1)",
                rusqlite::params![m.version, m.description],
            )
            .unwrap();
        }
        ensure_migrated(&conn).unwrap();
        // 补列 + 回填：升级后第一次启动就把老库的指纹补齐
        let nulls: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE checksum IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(nulls, 0);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64, "老库不重跑迁移");
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

    /// 直接应用一个迁移的 SQL（不走运行器）。自带事务的迁移依赖事务外的 PRAGMA，
    /// 这里要照抄 apply_one_owning_transaction 的处理，否则重建表会失败。
    fn apply_raw(conn: &Connection, m: &Migration) {
        if OWN_TRANSACTION_VERSIONS.contains(&m.version) {
            conn.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;")
                .unwrap();
            conn.execute_batch(m.sql).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF;")
                .unwrap();
        } else {
            conn.execute_batch(m.sql).unwrap();
        }
    }

    #[test]
    fn baseline_seeds_from_sqlx_table_without_reapplying() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟存量库：手动应用全部迁移 SQL + 建 _sqlx_migrations 记账表
        create_sqlx_table(&conn);
        for m in MIGRATIONS {
            apply_raw(&conn, m);
            record_sqlx_migration(&conn, m);
        }
        ensure_migrated(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
        // 若发生重复应用，001 的裸 CREATE TABLE 会让 ensure_migrated 报错 —— 上面 unwrap 已证明未发生
    }

    /// 存量库：建 `_sqlx_migrations` 记账表，并只应用 version 之前的迁移
    fn apply_older_than(conn: &Connection, version: i64) {
        create_sqlx_table(conn);
        for m in MIGRATIONS.iter().take_while(|m| m.version < version) {
            apply_raw(conn, m);
            record_sqlx_migration(conn, m);
        }
    }

    /// 存量库（001–006 已应用，extra 里带着已废弃的 mode 键）升到 007：
    /// 只加列 + 清死键，不重跑建表；非法 JSON 的 extra 既不能炸迁移也不该被改写。
    #[test]
    fn migration_007_upgrades_existing_install_and_strips_stale_mode_key() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 7);
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        for (id, extra) in [("v1", r#"{"mode":"board","sorts":[]}"#), ("v2", "not json")] {
            conn.execute(
                "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
                 VALUES (?1, 'w1', '表', 'grid', ?2, 0, 1, 1)",
                rusqlite::params![id, extra],
            )
            .unwrap();
        }

        ensure_migrated(&conn).unwrap();

        let src: Option<String> = conn
            .query_row("SELECT source_id FROM views WHERE id = 'v1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(src, None, "存量行都是宿主");
        let kept: String = conn
            .query_row("SELECT extra FROM views WHERE id = 'v1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, r#"{"sorts":[]}"#, "只删 mode 死键，其余键原样保留");
        let untouched: String = conn
            .query_row("SELECT extra FROM views WHERE id = 'v2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            untouched, "not json",
            "非法 JSON 由 json_valid 挡在清理之外"
        );
    }

    /// 存量库（1–7 已应用，表里已有单元格数据）升到 008：
    /// 建索引表时要回填存量行，之后的写入才由触发器接手。
    #[test]
    fn migration_008_backfills_existing_cells_into_fts() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 8);
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1','w1','任务表','grid','{}',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
               VALUES ('f1','v1','状态','single_select',
                       '{"kind":"select","options":[{"id":"opt_a","name":"待评审","color":"blue"}]}',180,0,0)"#,
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES ('r1','v1',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','"opt_a"')"#,
            [],
        )
        .unwrap();

        ensure_migrated(&conn).unwrap();

        let indexed = || -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM database_fts WHERE content = '待评审'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(indexed(), 1, "存量单元格要回填成选项名，而不是 id");

        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES ('r2','v1',1,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r2','f1','"opt_a"')"#,
            [],
        )
        .unwrap();
        assert_eq!(indexed(), 2, "升级后的新单元格由触发器入索引");
    }

    /// 存量库（1–9 已应用，documents_fts 里存的是 TipTap JSON 原文）升到 010：
    /// 索引整表重建为纯文本；升级后的写入由新触发器继续抽文本。
    #[test]
    fn migration_010_rebuilds_document_index_as_plain_text() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 10);
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1','w1','笔记','document','{}',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO documents(view_id, content, updated_at)
               VALUES ('v1', '{"type":"doc","content":[{"type":"text","text":"周末爬山计划"}]}', 1)"#,
            [],
        )
        .unwrap();
        let before: String = conn
            .query_row(
                "SELECT content FROM documents_fts WHERE view_id = 'v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            before.contains("\"type\""),
            "旧索引里是 JSON 原文：{before}"
        );

        ensure_migrated(&conn).unwrap();

        let after: String = conn
            .query_row(
                "SELECT content FROM documents_fts WHERE view_id = 'v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, "周末爬山计划");

        // 升级后的写入继续走同一条抽取路径
        conn.execute(
            r#"UPDATE documents SET content = '{"type":"doc","content":[{"type":"text","text":"改成海边露营"}]}'
               WHERE view_id = 'v1'"#,
            [],
        )
        .unwrap();
        let updated: String = conn
            .query_row(
                "SELECT content FROM documents_fts WHERE view_id = 'v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated, "改成海边露营");
    }

    /// 存量库（1–10 已应用，索引行的 rowid 与 database_cells.rowid 无对应关系）升到 011：
    /// 索引整表重建建立映射，之后按 rowid 的增删改必须命中正确的行（错位会删掉别人的索引）。
    #[test]
    fn migration_011_rebuilds_cell_index_rowids() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 11);
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1','w1','任务表','grid','{}',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES ('f1','v1','标题','text','{}',180,0,0)",
            [],
        )
        .unwrap();
        for r in ["r1", "r2"] {
            conn.execute(
                "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at)
                 VALUES (?1,'v1',0,1,1)",
                [r],
            )
            .unwrap();
        }
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','"甲"')"#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r2','f1','"乙"')"#,
            [],
        )
        .unwrap();
        // 故意把升级前索引行的 rowid 挪到与 database_cells.rowid 不同的值
        conn.execute("DELETE FROM database_fts", []).unwrap();
        conn.execute(
            "INSERT INTO database_fts(rowid, view_id, row_id, field_id, content)
             SELECT 1000 + c.rowid, t.view_id, t.row_id, t.field_id, t.txt
             FROM database_cell_text t
             JOIN database_cells c ON c.row_id = t.row_id AND c.field_id = t.field_id",
            [],
        )
        .unwrap();

        ensure_migrated(&conn).unwrap();

        // 映射已重建：每一行索引的 rowid 都等于对应单元格的 rowid
        let mismatched: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fts f JOIN database_cells c ON c.rowid = f.rowid
                  WHERE f.row_id <> c.row_id OR f.field_id <> c.field_id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mismatched, 0, "升级后 rowid 映射必须与单元格一一对应");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2);

        // 删除走 rowid：只能带走自己的索引行
        conn.execute(
            "DELETE FROM database_cells WHERE row_id = 'r1' AND field_id = 'f1'",
            [],
        )
        .unwrap();
        let left: Vec<String> = conn
            .prepare("SELECT row_id FROM database_fts ORDER BY row_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            left,
            vec!["r2"],
            "删单元格不能误删其它行的索引（rowid 错位）"
        );

        // 更新走同一条路径：内容刷新到正确的行，且不新增索引行
        conn.execute(
            "UPDATE database_cells SET value = '\"丙\"' WHERE row_id = 'r2' AND field_id = 'f1'",
            [],
        )
        .unwrap();
        let txt: String = conn
            .query_row(
                "SELECT content FROM database_fts WHERE row_id = 'r2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(txt, "丙");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
    }

    /// 存量库（1–11 已应用，表里已有单元格数据）升到 012：
    /// 重建 database_fields 改 CHECK 约束，必须在 foreign_keys=OFF 下进行，
    /// 否则 DROP TABLE 的隐式 DELETE 会把 database_cells 全部级联删除。
    #[test]
    fn migration_012_rebuilds_field_check_without_losing_cells() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 12);
        // 模拟生产连接：迁移前 FK 已是开启状态
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
        "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
         VALUES ('v1','w1','任务表','grid','{}',0,1,1)",
        [],
    )
    .unwrap();
        conn.execute(
        "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
         VALUES ('f1','v1','标题','text','{}',180,0,0)",
        [],
    )
    .unwrap();
        conn.execute(
        "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES ('r1','v1',0,1,1)",
        [],
    )
    .unwrap();
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','"甲"')"#,
            [],
        )
        .unwrap();

        ensure_migrated(&conn).unwrap();

        // 单元格没被 DROP TABLE 的级联删掉
        let cells: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_cells", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cells, 1, "重建字段表不能级联删除单元格");
        let fields: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_fields", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fields, 1, "字段数据原样保留");

        // 新类型（formula / rollup）现在可以写入，relation 仍可写
        for (id, ft) in [("f2", "formula"), ("f3", "rollup"), ("f4", "relation")] {
            conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES (?1,'v1',?1,?2,'{\"kind\":\"none\"}',180,0,1)",
            rusqlite::params![id, ft],
        )
        .unwrap_or_else(|e| panic!("{ft} 应被 CHECK 接受: {e}"));
        }
        // 未知类型仍被拒绝
        let err = conn
        .execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES ('f9','v1','x','ghost_type','{}',180,0,2)",
            [],
        )
        .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "{err}");

        // 重建字段表时挂在其上的 FTS 触发器要恢复：改 options 仍能刷新索引
        conn.execute("UPDATE database_fields SET options = '{\"kind\":\"select\",\"options\":[]}' WHERE id = 'f1'", [])
        .unwrap();
        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fts WHERE content = '甲'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1);

        // 迁移结束两个连接级 PRAGMA 必须恢复原状
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "迁移后必须恢复 foreign_keys=ON");
        let legacy: i64 = conn
            .query_row("PRAGMA legacy_alter_table", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 0, "迁移后必须恢复 legacy_alter_table=OFF");
    }

    /// 存量库（1–12 已应用）升到 013：重建 database_fields 把 attachment / reverse_relation
    /// 纳入 CHECK 白名单，同样必须在 foreign_keys=OFF 下进行以免级联清空单元格。
    #[test]
    fn migration_013_extends_field_check_without_losing_cells() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 13);
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1','w1','任务表','grid','{}',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES ('f1','v1','标题','text','{}',180,0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES ('r1','v1',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','"甲"')"#,
            [],
        )
        .unwrap();

        ensure_migrated(&conn).unwrap();

        let cells: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_cells", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cells, 1, "重建字段表不能级联删除单元格");

        // 新类型（attachment / reverse_relation）现在可以写入，既有 relation 仍可写
        for (id, ft) in [
            ("f2", "attachment"),
            ("f3", "reverse_relation"),
            ("f4", "relation"),
        ] {
            conn.execute(
                "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
                 VALUES (?1,'v1',?1,?2,'{}',180,0,1)",
                rusqlite::params![id, ft],
            )
            .unwrap_or_else(|e| panic!("{ft} 应被 CHECK 接受: {e}"));
        }
        // 未知类型仍被拒绝
        let err = conn
            .execute(
                "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
                 VALUES ('f9','v1','x','ghost_type','{}',180,0,2)",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "{err}");

        // 重建字段表时挂在其上的 FTS 触发器要恢复：改 options 仍能刷新索引
        conn.execute(
            "UPDATE database_fields SET options = '{\"kind\":\"select\",\"options\":[]}' WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fts WHERE content = '甲'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1);

        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "迁移后必须恢复 foreign_keys=ON");
        let legacy: i64 = conn
            .query_row("PRAGMA legacy_alter_table", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 0, "迁移后必须恢复 legacy_alter_table=OFF");
    }

    /// 存量库（1–13 已应用）升到 014：重建 views 把 layout 白名单加入 'timeline'。
    /// 同样必须在 foreign_keys=OFF 下进行，否则 DROP TABLE 的隐式 DELETE 会经
    /// ON DELETE CASCADE 清空 documents / 派生视图等子表数据。
    #[test]
    fn migration_014_extends_layout_check_without_losing_views() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 14);
        // 模拟生产连接：迁移前 FK 已是开启状态
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        // 宿主视图：带上 visited_at / tags 以验证重建后列与数据都不丢
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, is_favorite, is_trash, created_at, updated_at, visited_at, tags)
             VALUES ('v1','w1','任务表','grid','{\"sorts\":[]}',0,1,0,1,1,123,'[\"工作\"]')",
            [],
        )
        .unwrap();
        // 派生视图：source_id 自引用宿主
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at, source_id)
             VALUES ('v2','w1','日历','calendar','{}',0,1,1,'v1')",
            [],
        )
        .unwrap();
        // 子表数据（FK 指向 views / 触发器引用 views）：重建 views 时不能被级联删除
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES ('v1','{}',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO document_snapshots(view_id, content, reason, created_at) VALUES ('v1','{}','auto',1)",
            [],
        )
        .unwrap();

        ensure_migrated(&conn).unwrap();

        // 行数不变、各列数据完好
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "重建 views 不能丢失行");
        let (name, layout, visited, tags, src): (String, String, i64, String, Option<String>) =
            conn.query_row(
                "SELECT name, layout, visited_at, tags, source_id FROM views WHERE id='v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(name, "任务表");
        assert_eq!(layout, "grid");
        assert_eq!(visited, 123, "visited_at 列必须保留");
        assert_eq!(tags, "[\"工作\"]", "tags 列必须保留");
        assert_eq!(src, None, "宿主视图 source_id 仍为 NULL");
        let derived: Option<String> = conn
            .query_row("SELECT source_id FROM views WHERE id='v2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            derived.as_deref(),
            Some("v1"),
            "派生视图的自引用外键必须保留"
        );

        // 子表数据没被 DROP TABLE 的级联删掉
        let docs: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(docs, 1, "重建 views 不能级联删除文档");
        let snaps: i64 = conn
            .query_row("SELECT COUNT(*) FROM document_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(snaps, 1, "重建 views 不能级联删除快照");

        // 新 layout（timeline）现在可以写入
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v3','w1','时间线','timeline','{}',0,1,1)",
            [],
        )
        .unwrap_or_else(|e| panic!("timeline 应被 CHECK 接受: {e}"));
        // 未知 layout 仍被拒绝
        let err = conn
            .execute(
                "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
                 VALUES ('v9','w1','x','ghost_layout','{}',0,1,1)",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "{err}");

        // 重建的表结构完整：三个索引 + 派生视图 partial 索引都在
        for idx in [
            "idx_views_ws_favorite",
            "idx_views_ws_layout",
            "idx_views_source_id",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "重建后缺少索引 {idx}");
        }

        // 重建的触发器仍在：改名同步 FTS、删除清理快照
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES ('v3','{}',1)",
            [],
        )
        .unwrap();
        conn.execute("UPDATE views SET name='时间线2' WHERE id='v3'", [])
            .unwrap();
        let title: String = conn
            .query_row(
                "SELECT title FROM documents_fts WHERE view_id='v3'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "时间线2", "重建后 trg_views_fts_rename 仍同步标题");

        // 自引用外键的级联删除仍生效（证明 source_id 的 FK 约束被重建）
        conn.execute("DELETE FROM views WHERE id='v1'", []).unwrap();
        let left: Vec<String> = conn
            .prepare("SELECT id FROM views ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, vec!["v3"], "删除宿主应级联删除派生视图 v2");
        // 删除走 trg_snapshots_purge：v1 的快照被清理
        let snaps: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_snapshots WHERE view_id='v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(snaps, 0, "重建后 trg_snapshots_purge 仍清理快照");

        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "迁移后必须恢复 foreign_keys=ON");
        let legacy: i64 = conn
            .query_row("PRAGMA legacy_alter_table", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 0, "迁移后必须恢复 legacy_alter_table=OFF");
    }

    /// 存量库（1–14 已应用）升到 015：重建 database_fields 把 progress / rating / currency
    /// 纳入 CHECK 白名单，同样不得级联清空单元格。
    #[test]
    fn migration_015_extends_field_check_lightweight() {
        let conn = Connection::open_in_memory().unwrap();
        apply_older_than(&conn, 15);
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1','w1','任务表','grid','{}',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES ('f1','v1','标题','text','{}',180,0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES ('r1','v1',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','"甲"')"#,
            [],
        )
        .unwrap();

        ensure_migrated(&conn).unwrap();

        let cells: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_cells", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cells, 1, "重建字段表不能级联删除单元格");

        // 新类型（progress / rating / currency）现在可以写入
        for (id, ft) in [("f2", "progress"), ("f3", "rating"), ("f4", "currency")] {
            conn.execute(
                "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
                 VALUES (?1,'v1',?1,?2,'{}',180,0,1)",
                rusqlite::params![id, ft],
            )
            .unwrap_or_else(|e| panic!("{ft} 应被 CHECK 接受: {e}"));
        }
        // 未知类型仍被拒绝
        let err = conn
            .execute(
                "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
                 VALUES ('f9','v1','x','ghost_type','{}',180,0,2)",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "{err}");

        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "迁移后必须恢复 foreign_keys=ON");
        let legacy: i64 = conn
            .query_row("PRAGMA legacy_alter_table", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 0, "迁移后必须恢复 legacy_alter_table=OFF");
    }

    #[test]
    fn fresh_install_does_not_create_legacy_sqlx_table() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_migrated(&conn).unwrap();
        let has_sqlx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            has_sqlx, 0,
            "tauri-plugin-sql 已移除，全新安装不该出现遗留记账表"
        );
    }

    #[test]
    fn existing_sqlx_table_is_never_rewritten() {
        let conn = Connection::open_in_memory().unwrap();
        create_sqlx_table(&conn);
        for m in MIGRATIONS {
            apply_raw(&conn, m);
            record_sqlx_migration(&conn, m);
        }
        ensure_migrated(&conn).unwrap();
        // 遗留表的行保持原样：不产生重复行，占位 checksum 也未被改写（基线导入是只读的）
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
            Migration {
                version: 1,
                description: "ok",
                sql: "CREATE TABLE t1(a);",
            },
            Migration {
                version: 2,
                description: "bad",
                sql: "CREATE TABLE t2(a); NOT VALID SQL HERE;",
            },
        ];
        let err = ensure_migrated_with(&conn, &bad).unwrap_err();
        assert!(err.contains("migration 2"), "{err}");
        // 事务回滚：t2 不存在，t1 已提交；连接仍可用
        let t2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 't2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(t2, 0);
        ensure_migrated_with(
            &conn,
            &[Migration {
                version: 1,
                description: "ok",
                sql: "CREATE TABLE t1(a);",
            }],
        )
        .unwrap();
    }
}
