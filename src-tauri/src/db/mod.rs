pub mod database;
pub mod docs;
pub mod mentions;
pub mod migrations;
pub mod models;
pub mod properties;
pub mod search;
pub mod settings;
pub mod views;
pub mod workspaces;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub use models::{
    BacklinkRow, CellLoadRow, CsvCellIn, CsvFieldIn, CsvRowIn, DatabaseFieldRow, DatabaseRowRow,
    DocRowOut, MentionRowIn, PagePropertyOut, SearchRowOut, ViewRow, WorkspaceRow,
};

pub const DB_FILE: &str = "appflowy.db";

/// 单写 + 单读两个连接（WAL 下读写可并发）。前端 SQL 层下沉后，写串行化由 write Mutex 保证，
/// 事务始终完整落在同一连接上（旧 JS withWriteLock 补丁的根因是插件连接池跨连接事务溶解）。
/// write/read 用 Option<Connection> 支持备份/恢复期间整体关闭再重开；
/// init_error 记录初始化失败信息（应用照常启动，所有 DB 命令返回该错误而非 panic）。
pub struct Db {
    path: PathBuf,
    write: Mutex<Option<Connection>>,
    read: Mutex<Option<Connection>>,
    init_error: Mutex<Option<String>>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// rusqlite::Error → "ctx: {e}" 错误串（与现有 commands 的错误风格一致，前端可直接展示）
pub fn dberr(ctx: &'static str) -> impl Fn(rusqlite::Error) -> String {
    move |e| format!("{ctx}: {e}")
}

impl Db {
    /// 永不 panic：打开/PRAGMA/迁移任一步失败都存入 init_error，应用照常启动。
    pub fn open(path: PathBuf) -> Db {
        let db = Db {
            path,
            write: Mutex::new(None),
            read: Mutex::new(None),
            init_error: Mutex::new(None),
        };
        if let Err(e) = db.open_connections() {
            tracing::error!(error = %e, "database init failed");
            *db.init_error.lock().unwrap() = Some(e);
        }
        db
    }

    #[cfg(test)]
    pub fn init_error_msg(&self) -> Option<String> {
        self.init_error.lock().unwrap().clone()
    }

    fn open_connections(&self) -> Result<(), String> {
        let write = Connection::open(&self.path).map_err(|e| format!("open db: {e}"))?;
        apply_pragmas(&write)?;
        migrations::ensure_migrated(&write)?;
        let read = Connection::open(&self.path).map_err(|e| format!("open db (read conn): {e}"))?;
        apply_pragmas(&read)?;
        *self.write.lock().unwrap() = Some(write);
        *self.read.lock().unwrap() = Some(read);
        Ok(())
    }

    pub fn write_conn(&self) -> Result<DbConnGuard<'_>, String> {
        DbConnGuard::new(self.write.lock().map_err(|_| "db state poisoned".to_string())?)
    }

    pub fn read_conn(&self) -> Result<DbConnGuard<'_>, String> {
        DbConnGuard::new(self.read.lock().map_err(|_| "db state poisoned".to_string())?)
    }

    /// 备份/恢复前调用：checkpoint 后整体关闭连接，此后 db 文件/数据目录在 Windows 上可改名删除。
    /// 持有任一连接的进行中命令会先执行完（它们握着锁），再轮到本函数。
    pub fn close_for_maintenance(&self) -> Result<(), String> {
        let mut write = self.write.lock().map_err(|_| "db state poisoned".to_string())?;
        let mut read = self.read.lock().map_err(|_| "db state poisoned".to_string())?;
        if let Some(conn) = write.as_ref() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        *write = None;
        read.take();
        *self.init_error.lock().unwrap() = Some("database is closed for maintenance".to_string());
        Ok(())
    }

    /// 重开连接并重跑迁移（恢复的备份可能 schema 更旧）。失败时保持关闭态，命令继续返回错误。
    pub fn reopen(&self) -> Result<(), String> {
        self.open_connections()?;
        *self.init_error.lock().unwrap() = None;
        Ok(())
    }
}

/// 包装 MutexGuard<Option<Connection>>：new 时校验非 None，Deref 直接给 &Connection。
pub struct DbConnGuard<'a>(MutexGuard<'a, Option<Connection>>);

impl<'a> DbConnGuard<'a> {
    fn new(guard: MutexGuard<'a, Option<Connection>>) -> Result<Self, String> {
        if guard.is_none() {
            return Err("database is closed or not initialized".to_string());
        }
        Ok(DbConnGuard(guard))
    }
}

impl std::ops::Deref for DbConnGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().unwrap()
    }
}

impl std::ops::DerefMut for DbConnGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.0.as_mut().unwrap()
    }
}

/// 镜像旧前端 db.ts:34-47 的 PRAGMA 集合。
/// journal_mode 失败不致命（与旧行为一致，某些环境返回 memory 也能用）；
/// foreign_keys 必须成功：purge/move/删除全依赖 FK 级联。
fn apply_pragmas(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| format!("pragma busy_timeout: {e}"))?;
    if let Err(e) = conn.pragma_update(None, "journal_mode", "WAL") {
        tracing::warn!(error = %e, "pragma journal_mode=WAL failed (non-fatal)");
    }
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "temp_store", "MEMORY");
    let _ = conn.pragma_update(None, "cache_size", -10_000i64);
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("pragma foreign_keys=ON: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> (PathBuf, Db) {
        let dir = std::env::temp_dir().join(format!("tsflowy-db-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join(DB_FILE));
        assert!(db.init_error_msg().is_none(), "db init should succeed");
        (dir, db)
    }

    #[test]
    fn journal_mode_is_wal_and_foreign_keys_on() {
        let (_dir, db) = temp_db("pragma");
        let conn = db.write_conn().unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn foreign_key_violation_is_rejected() {
        let (_dir, db) = temp_db("fk");
        let conn = db.write_conn().unwrap();
        let err = conn
            .execute(
                "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
                 VALUES ('v1', 'ghost-ws', 'n', 'grid', '{}', 0, 1, 1)",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("FOREIGN KEY"), "{err}");
    }

    #[test]
    fn commands_fail_cleanly_after_close() {
        let (_dir, db) = temp_db("closed");
        db.close_for_maintenance().unwrap();
        let err = match db.write_conn() {
            Err(e) => e,
            Ok(_) => panic!("expected closed-db error"),
        };
        assert!(err.contains("closed"), "{err}");
    }

    #[test]
    fn close_allows_file_rename_then_reopen_reads_data() {
        let (dir, db) = temp_db("rename");
        {
            let conn = db.write_conn().unwrap();
            conn.execute(
                "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
                [],
            )
            .unwrap();
        }
        // 关库 → 文件可改名（Windows 下连接未关时 rename 会失败）→ 改回来 → reopen 数据可读
        db.close_for_maintenance().unwrap();
        let path = dir.join(DB_FILE);
        let moved = dir.join("moved.db");
        std::fs::rename(&path, &moved).unwrap();
        std::fs::rename(&moved, &path).unwrap();
        db.reopen().unwrap();
        let n: i64 = db
            .read_conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        // reopen 重跑了迁移：schema_migrations 满行
        let m: i64 = db
            .read_conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(m, migrations::MIGRATIONS.len() as i64);
    }
}
