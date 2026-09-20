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

    /// 模拟存量库：建 `_sqlx_migrations` 记账表，并只应用 version 之前的迁移
    fn apply_older_than(conn: &Connection, version: i64) {
        create_sqlx_table(conn);
        for m in MIGRATIONS.iter().take_while(|m| m.version < version) {
            conn.execute_batch(m.sql).unwrap();
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
            .query_row("SELECT source_id FROM views WHERE id = 'v1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src, None, "存量行都是宿主");
        let kept: String = conn
            .query_row("SELECT extra FROM views WHERE id = 'v1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, r#"{"sorts":[]}"#, "只删 mode 死键，其余键原样保留");
        let untouched: String = conn
            .query_row("SELECT extra FROM views WHERE id = 'v2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(untouched, "not json", "非法 JSON 由 json_valid 挡在清理之外");
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
            .query_row("SELECT content FROM documents_fts WHERE view_id = 'v1'", [], |r| r.get(0))
            .unwrap();
        assert!(before.contains("\"type\""), "旧索引里是 JSON 原文：{before}");

        ensure_migrated(&conn).unwrap();

        let after: String = conn
            .query_row("SELECT content FROM documents_fts WHERE view_id = 'v1'", [], |r| r.get(0))
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
            .query_row("SELECT content FROM documents_fts WHERE view_id = 'v1'", [], |r| r.get(0))
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
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM database_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2);

        // 删除走 rowid：只能带走自己的索引行
        conn.execute("DELETE FROM database_cells WHERE row_id = 'r1' AND field_id = 'f1'", []).unwrap();
        let left: Vec<String> = conn
            .prepare("SELECT row_id FROM database_fts ORDER BY row_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, vec!["r2"], "删单元格不能误删其它行的索引（rowid 错位）");

        // 更新走同一条路径：内容刷新到正确的行，且不新增索引行
        conn.execute("UPDATE database_cells SET value = '\"丙\"' WHERE row_id = 'r2' AND field_id = 'f1'", [])
            .unwrap();
        let txt: String = conn
            .query_row("SELECT content FROM database_fts WHERE row_id = 'r2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(txt, "丙");
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM database_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1);
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
