use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::db::{Db, DbInner, DB_FILE};

use super::auto_backup::{backup_dir, backup_stamp, format_local_time, latest_auto_backup};
use super::config::load_app_config;
use super::data_dir::{
    app_data_dir, clear_dangling_data_dir_warning, dangling_data_dir_warning, real_data_dir,
    target_data_dir,
};

/// 数据库不可用时的诊断信息：把**真实失败原因**与所有可操作路径交给前端，
/// 用户据此能自己判断（文件被占用 / 磁盘满 / 迁移失败）并一键导入备份恢复，
/// 而不是只看到一句无从下手的 error.db。
#[derive(Serialize)]
pub struct DbHealth {
    /// 读写连接是否可用；false 时所有 DB 命令都会失败
    pub ok: bool,
    /// 真实失败原因（连接正常时为 None）
    pub error: Option<String>,
    /// 数据库文件绝对路径与大小
    pub db_path: String,
    pub db_size_bytes: u64,
    /// 数据目录（库文件与 assets 所在，junction 的真实落点）
    pub data_dir: String,
    /// 自动备份目录
    pub backup_dir: String,
    /// 最近一份自动备份：文件名 / 绝对路径 / 本地时间（无备份时均为 None）
    pub latest_backup: Option<String>,
    pub latest_backup_path: Option<String>,
    pub latest_backup_time: Option<String>,
    /// 悬空目录联接告警：启动时检测到数据目录目标已被外部删除（正常为 None）。
    /// 有值时说明当前库不是原来的库，前端应提示用户从备份恢复。
    pub dangling_data_dir: Option<String>,
}

#[tauri::command]
pub async fn db_health(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
) -> Result<DbHealth, String> {
    let data_dir = real_data_dir(&app)?;
    let db_path = db.db_path();
    let backup = backup_dir(&app)?;
    let latest = latest_auto_backup(&backup);
    let error = db.init_error_msg();
    Ok(DbHealth {
        ok: error.is_none(),
        error,
        db_size_bytes: fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0),
        db_path: db_path.to_string_lossy().to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        backup_dir: backup.to_string_lossy().to_string(),
        latest_backup: latest.as_ref().map(|(n, _, _)| n.clone()),
        latest_backup_path: latest
            .as_ref()
            .map(|(_, p, _)| p.to_string_lossy().to_string()),
        latest_backup_time: latest.as_ref().map(|(_, _, t)| format_local_time(*t)),
        dangling_data_dir: dangling_data_dir_warning(),
    })
}

/// 兜底页「重建数据目录」：仅在启动检测到悬空联接、且用户确认放弃等待恢复时调用。
/// 补建目标目录（悬空联接随之恢复可用）并重开数据库，因此得到的是一个新空库。
#[tauri::command]
pub async fn rebuild_data_dir(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
) -> Result<DbHealth, String> {
    // 默认落点已回归 app_data_dir 真实目录：老版本留下的悬空联接要摘掉，
    // 否则 create_dir_all 会走进不存在的目标、数据库仍打不开。
    // 自定义目录模式下联接仍指向用户选的目录，保留不动。
    let default = app_data_dir(&app)?;
    if load_app_config(&app).custom_data_dir.is_none()
        && fs::symlink_metadata(&default)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        && !default.exists()
    {
        let _ = fs::remove_dir(&default).or_else(|_| fs::remove_file(&default));
    }
    let target = target_data_dir(&app)?;
    fs::create_dir_all(&target).map_err(|e| format!("mkdir data dir: {e}"))?;
    db.reopen()?;
    clear_dangling_data_dir_warning();
    db_health(app, db).await
}

// ———— 数据库结构健康：检查与修复 ————
//
// 库能打开 ≠ 库是好的。网盘把主库同步成半截、写入途中被强杀、磁盘坏道，都会留下
// "打开不报错、读到某张表才 malformed" 的库；没有检查入口时用户只会看到某个页面打不开，
// 完全想不到是库坏了，更不知道该怎么办。
// 这里给出两件事：一条能说出坏在哪里的检查，和一条把还能读的内容救出来的修复。
// 修复全程只改名、不删除：每一步被替换掉的文件都留在数据目录里，用户随时能改回原名。

/// 一次结构检查最多带回去多少行报错（够定位到表/页即可，坏库能报上万行）
const MAX_MESSAGES: usize = 40;

/// `check_db_integrity` 的返回
#[derive(Serialize)]
pub struct IntegrityReport {
    pub ok: bool,
    /// true = `PRAGMA integrity_check`（整库深扫，慢）；false = `PRAGMA quick_check`（快，够巡检）
    pub deep: bool,
    pub took_ms: u64,
    pub db_path: String,
    pub db_size_bytes: u64,
    /// PRAGMA 的输出行：健康时是 ["ok"]，坏时具体到哪张表/哪个页
    pub messages: Vec<String>,
}

/// 修复过程中被挪开的文件（原路径 → 现路径）
#[derive(Serialize, Clone)]
pub struct KeptAside {
    pub from: String,
    pub to: String,
}

/// `repair_database` 的返回
#[derive(Serialize)]
pub struct DbRepairResult {
    /// none = 本来就健康（一个文件都没动）
    /// wal = 挪开可疑的 -wal/-shm 侧车后就健康了（网盘/中断写入最常见的坏法）
    /// rebuild = 用 VACUUM INTO 把还能读的内容重建成新的库文件
    /// failed = 两条路都没救回来；原库分毫未动，请改用「导入备份」
    pub action: &'static str,
    /// 处理完是否健康
    pub ok: bool,
    /// 修复前查出的问题
    pub before: Vec<String>,
    /// 修复后的检查结果
    pub after: Vec<String>,
    pub kept_aside: Vec<KeptAside>,
}

/// 主库旁边的侧车文件名：`appflowy.db-wal` / `appflowy.db-shm`
fn sidecar_path(db_path: &Path, ext: &str) -> std::path::PathBuf {
    let base = db_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| DB_FILE.to_string());
    db_path.with_file_name(format!("{base}{ext}"))
}

/// 同目录下带标记的文件名：`appflowy.db.corrupt-20261015-181530`
fn marked_name(db_path: &Path, marker: &str) -> std::path::PathBuf {
    let base = db_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| DB_FILE.to_string());
    db_path.with_file_name(format!("{base}.{marker}-{}", backup_stamp()))
}

/// 打开库文件跑检查。
/// 用**读写**连接而不是只读：WAL 模式的库在只读连接下常常连 `-shm` 都建不起来，
/// 直接 CANTOPEN 报错会被误判成「库坏了」；读写打开时 SQLite 顺手做的 WAL 回放，
/// 正是应用重开时本来就会做（也必然要做）的事，检查结论才和实际运行一致。
///
/// 用独立连接而不是应用的共享读连接：一次深检查要整库扫几十秒，
/// 挂在共享读连接上会把所有页面读取都堵在这条语句后面。
fn open_for_check(p: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        p,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open database failed: {e}"))?;
    let _ = conn.busy_timeout(Duration::from_secs(10));
    Ok(conn)
}

/// 跑一次 PRAGMA 结构检查。查询本身报错（库坏到连检查都做不完）同样算不通过，
/// 并把那句错误带回去——它往往就是最关键的线索。
fn pragma_messages(conn: &Connection, deep: bool) -> (bool, Vec<String>) {
    let sql = if deep {
        "PRAGMA integrity_check"
    } else {
        "PRAGMA quick_check"
    };
    let rows = conn
        .prepare(sql)
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<String>, _>>()
        })
        .unwrap_or_else(|e| vec![e.to_string()]);
    let mut messages = rows;
    let truncated = messages.len() > MAX_MESSAGES;
    messages.truncate(MAX_MESSAGES);
    if truncated {
        messages.push(format!("…（其余报错已省略，共超过 {MAX_MESSAGES} 行）"));
    }
    let ok = messages.len() == 1 && messages[0] == "ok";
    (ok, messages)
}

/// 对某个库文件做一次检查并汇总成前端可读的报告
pub(crate) fn integrity_report(path: &Path, deep: bool) -> IntegrityReport {
    let started = Instant::now();
    let (ok, messages) = match open_for_check(path) {
        Ok(conn) => pragma_messages(&conn, deep),
        Err(e) => (false, vec![e]),
    };
    IntegrityReport {
        ok,
        deep,
        took_ms: started.elapsed().as_millis() as u64,
        db_path: path.to_string_lossy().to_string(),
        db_size_bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        messages,
    }
}

/// 只关心「深检查过不过 + 报了什么」，用于修复阶梯里的复查
fn check_deep(path: &Path) -> (bool, Vec<String>) {
    match open_for_check(path) {
        Ok(conn) => pragma_messages(&conn, true),
        Err(e) => (false, vec![e]),
    }
}

/// 结构检查（设置页按钮与启动后的后台巡检共用）。
/// 深度检查在慢盘/大库上要几十秒，放 blocking 线程，别占着 tokio worker。
#[tauri::command]
pub async fn check_db_integrity(
    db: tauri::State<'_, Db>,
    deep: Option<bool>,
) -> Result<IntegrityReport, String> {
    let deep = deep.unwrap_or(false);
    let path = db.db_path();
    tauri::async_runtime::spawn_blocking(move || -> Result<IntegrityReport, String> {
        Ok(integrity_report(&path, deep))
    })
    .await
    .map_err(|e| format!("integrity check task failed: {e}"))?
}

/// 把 `from` 改名到同目录带时间戳的新名字，返回 (原, 现)。改名失败即整步失败。
fn move_aside(from: &Path, to: &Path) -> Result<KeptAside, String> {
    fs::rename(from, to).map_err(|e| format!("move {} aside failed: {e}", from.display()))?;
    Ok(KeptAside {
        from: from.to_string_lossy().to_string(),
        to: to.to_string_lossy().to_string(),
    })
}

/// 修复入口：先挪开可疑的 WAL 侧车，再尝试 VACUUM INTO 重建。
/// 全程只改名不删除，任何一步失败都原样放回并把原因带回去。
#[tauri::command]
pub async fn repair_database(db: tauri::State<'_, Db>) -> Result<DbRepairResult, String> {
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || repair_blocking(&db))
        .await
        .map_err(|e| format!("repair task failed: {e}"))?
}

fn repair_blocking(db: &DbInner) -> Result<DbRepairResult, String> {
    let path = db.db_path();
    if !path.is_file() {
        return Err(format!("database file not found: {}", path.display()));
    }
    // 本来就健康就别关库：修复是用户主动点的，一次维护窗口会让所有命令暂时失败
    let before = integrity_report(&path, true);
    if before.ok {
        return Ok(DbRepairResult {
            action: "none",
            ok: true,
            before: Vec::new(),
            after: before.messages,
            kept_aside: Vec::new(),
        });
    }
    // 换文件必须先关库：Windows 下连接未关时主库与侧车都无法改名
    db.close_for_maintenance()?;
    let result = repair_ladder(&path, before.messages);
    // 无论修没修好都要重开：否则应用会停在"库已关闭"的状态
    db.reopen()?;
    result
}

/// 关库之后的修复阶梯。与 DbInner 无关，只对着文件干活（便于单测）。
fn repair_ladder(path: &Path, before: Vec<String>) -> Result<DbRepairResult, String> {
    let mut kept: Vec<KeptAside> = Vec::new();
    // 1) WAL/SHM 侧车：网盘把主库与侧车同步成不同源、或写入被强杀留下半截 WAL，
    //    是最常见也最容易误判成"库坏了"的情况。挪开后重建侧车即可，原文件留着。
    let mut sidecars: Vec<KeptAside> = Vec::new();
    for ext in ["-wal", "-shm"] {
        let side = sidecar_path(path, ext);
        if !side.is_file() {
            continue;
        }
        sidecars.push(move_aside(
            &side,
            &marked_name(path, &format!("repair{ext}")),
        )?);
    }
    kept.extend(sidecars.iter().cloned());
    if !sidecars.is_empty() {
        let (ok, messages) = check_deep(path);
        if ok {
            return Ok(DbRepairResult {
                action: "wal",
                ok: true,
                before,
                after: messages,
                kept_aside: kept,
            });
        }
        // 侧车不是原因：放回原处再试重建（放回失败也不致命，主库内容才是主角）
        for record in &sidecars {
            let _ = fs::rename(Path::new(&record.to), &record.from);
        }
        kept.retain(|k| !sidecars.iter().any(|s| s.to == k.to));
    }

    // 2) VACUUM INTO 重建：把还能按逻辑读出来的内容整份拷进一个新文件，顺带丢掉坏掉的
    //    freelist/溢出页。成功后新库替换旧库，旧库改名留着。
    //    重建的输入是主库的**副本**（连同尚未合并进主库的 -wal），原库自始至终只被读：
    //    SQLite 在读写打开副本时可能就地改写头部（比如把页数字段缩到真实文件大小），
    //    这类"顺手修头"发生在副本上才安全。
    let staged = marked_name(path, "repair-stage");
    let rebuilt = marked_name(path, "repair-rebuild");
    let staged_side = sidecar_path(&staged, "-wal");
    let vacuum = (|| {
        fs::copy(path, &staged).map_err(|e| format!("copy db for rebuild failed: {e}"))?;
        let wal = sidecar_path(path, "-wal");
        if wal.is_file() {
            let _ = fs::copy(&wal, &staged_side);
        }
        let conn = open_for_check(&staged)?;
        conn.execute("VACUUM INTO ?1", [rebuilt.to_string_lossy().as_ref()])
            .map_err(|e| format!("vacuum failed: {e}"))?;
        // VACUUM INTO 只保证写出来的文件是它自己认为好的，仍要独立复查一遍
        let (ok, messages) = check_deep(&rebuilt);
        if ok {
            Ok(messages)
        } else {
            Err(format!("rebuild not healthy: {}", messages.join("; ")))
        }
    })();
    remove_staged(&staged);
    let after = match vacuum {
        Ok(messages) => messages,
        Err(e) => {
            let _ = fs::remove_file(&rebuilt);
            return Ok(DbRepairResult {
                action: "failed",
                ok: false,
                before,
                after: vec![format!("重建未能成功：{e}")],
                kept_aside: kept,
            });
        }
    };
    // 装新库：旧库连同侧车一起挪走，否则旧 WAL 会被回放进新库（与备份导入同一课）
    kept.push(move_aside(path, &marked_name(path, "corrupt"))?);
    fs::rename(&rebuilt, path).map_err(|e| format!("install rebuilt db failed: {e}"))?;
    for ext in ["-wal", "-shm"] {
        let side = sidecar_path(path, ext);
        if side.is_file() {
            let to = marked_name(path, &format!("stale{ext}"));
            kept.push(move_aside(&side, &to)?);
        }
    }
    let (ok, check) = check_deep(path);
    Ok(DbRepairResult {
        action: "rebuild",
        ok,
        before,
        after: if ok { check } else { after },
        kept_aside: kept,
    })
}

/// 清掉阶梯自己造出来的临时件（副本不是用户数据，可以直接删）
fn remove_staged(staged: &Path) {
    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(sidecar_path(staged, ext));
    }
    let _ = fs::remove_file(staged);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> std::path::PathBuf {
        let base =
            std::env::temp_dir().join(format!("tsflowy-health-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// 一个真库（跑过迁移），带一行数据，确保检查扫到的不是空库
    fn make_db(dir: &Path) -> Db {
        let db = Db::open(dir.join(DB_FILE));
        {
            let conn = db.write_conn().unwrap();
            conn.execute(
                "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
                [],
            )
            .unwrap();
        }
        db
    }

    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    /// 把某个中段页的 btree 头改成垃圾：结构检查一定会抓到，但文件字节数不变
    fn corrupt_page(db_file: &Path) {
        let mut bytes = fs::read(db_file).unwrap();
        let page = 3usize; // 第 1 页是文件头，第 2 页是 schema，第 3 页起是各表根页
        let off = (page - 1) * 4096;
        assert!(off + 8 < bytes.len(), "库太小，不足以构造坏页");
        bytes[off..off + 8].fill(0xff);
        fs::write(db_file, &bytes).unwrap();
    }

    #[test]
    fn healthy_db_passes_both_checks() {
        let base = temp_base("ok");
        let db = make_db(&base);
        let path = db.db_path();
        for deep in [false, true] {
            let r = integrity_report(&path, deep);
            assert!(r.ok, "deep={deep} 消息：{:?}", r.messages);
            assert_eq!(r.messages, vec!["ok".to_string()]);
            assert_eq!(r.deep, deep);
            assert!(r.db_size_bytes > 0);
        }
    }

    #[test]
    fn unreadable_files_report_a_reason_instead_of_panicking() {
        let base = temp_base("junk");
        // 根本不是库的文件
        let junk = base.join("not-a.db");
        fs::write(&junk, b"this is a text file, not sqlite").unwrap();
        let r = integrity_report(&junk, true);
        assert!(!r.ok);
        assert!(!r.messages.is_empty(), "坏文件必须带回报错内容");

        // 不存在的文件（open 带 READ_WRITE 不会顺手建空库）
        let missing = integrity_report(&base.join("nope.db"), false);
        assert!(!missing.ok);
        assert!(missing.db_size_bytes == 0);
    }

    #[test]
    fn corrupt_db_fails_the_check() {
        let base = temp_base("corrupt");
        let db = make_db(&base);
        let path = db.db_path();
        db.close_for_maintenance().unwrap();
        corrupt_page(&path);
        let r = integrity_report(&path, true);
        assert!(!r.ok, "改了页头还检查通过，用例本身失效：{:?}", r.messages);
    }

    #[test]
    fn repair_leaves_a_healthy_db_completely_untouched() {
        let base = temp_base("none");
        let db = make_db(&base);
        let before = dir_entries(&base);
        let r = repair_blocking(&db.shared()).unwrap();
        assert_eq!(r.action, "none");
        assert!(r.ok);
        assert!(r.kept_aside.is_empty());
        // 健康时连维护窗口都不该开：文件列表一字不差
        assert_eq!(dir_entries(&base), before);
    }

    #[test]
    fn ladder_step_one_cure_only_moves_sidecars() {
        let base = temp_base("wal");
        let db = make_db(&base);
        let path = db.db_path();
        db.close_for_maintenance().unwrap();
        // 伪造一对"看着可疑"的侧车（无效 WAL 会被 SQLite 忽略，主库本身是好的）
        let wal = sidecar_path(&path, "-wal");
        let shm = sidecar_path(&path, "-shm");
        fs::write(&wal, b"half a wal").unwrap();
        fs::write(&shm, b"stale shm").unwrap();
        let main_before = fs::read(&path).unwrap();

        let r = repair_ladder(&path, vec!["fake complaint".to_string()]).unwrap();
        assert_eq!(r.action, "wal");
        assert!(r.ok);
        assert_eq!(r.before, vec!["fake complaint".to_string()]);
        assert_eq!(r.kept_aside.len(), 2);
        // 主库一个字节都没动，侧车只是改了名躺在同目录里
        assert_eq!(fs::read(&path).unwrap(), main_before);
        assert!(!wal.exists() && !shm.exists());
        for k in &r.kept_aside {
            assert!(Path::new(&k.to).is_file(), "被挪开的文件必须还在：{}", k.to);
        }
    }

    #[test]
    fn failed_rebuild_keeps_the_original_file() {
        let base = temp_base("failed");
        let db = make_db(&base);
        let path = db.db_path();
        db.close_for_maintenance().unwrap();
        corrupt_page(&path);
        let broken = fs::read(&path).unwrap();
        let entries_before = dir_entries(&base);

        let r = repair_ladder(&path, vec!["bad page".to_string()]).unwrap();
        // 坏页连 VACUUM 都读不下去：这条路必须明确承认失败，而不是交出一个残缺库
        assert_eq!(r.action, "failed");
        assert!(!r.ok);
        assert_eq!(r.before, vec!["bad page".to_string()]);
        assert_eq!(fs::read(&path).unwrap(), broken, "修复失败绝不能吃掉原库");
        // 失败时目录里既不该多出改名文件，也不该留下阶梯自己的临时件
        assert_eq!(dir_entries(&base), entries_before);
    }

    #[test]
    fn rebuild_rescues_a_db_whose_data_is_still_readable() {
        let base = temp_base("rebuild");
        let db = make_db(&base);
        let path = db.db_path();
        db.close_for_maintenance().unwrap();
        // 把「文件头里的 freelist 指针」指到一张非 trunk 页：结构检查一定报错，
        // 但所有表的逻辑内容照读不误——正是 VACUUM INTO 能救回来的那一类坏法。
        let mut bytes = fs::read(&path).unwrap();
        bytes[32..36].copy_from_slice(&2u32.to_be_bytes());
        bytes[36..40].copy_from_slice(&1u32.to_be_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(
            !integrity_report(&path, true).ok,
            "这一步的前提是库确实报错"
        );

        let r = repair_ladder(&path, vec!["bad freelist".to_string()]).unwrap();
        assert_eq!(r.action, "rebuild");
        assert!(r.ok, "重建后的复查没通过：{:?}", r.after);
        // 原库改名留在原地，随时能改回
        let corrupt = r.kept_aside.iter().find(|k| k.to.contains("corrupt-"));
        assert!(corrupt.is_some(), "旧库应改名留在原地");
        assert_eq!(corrupt.unwrap().from, path.to_string_lossy());
        // 新库确实能打开、数据还在
        let conn = Connection::open(&path).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "重建把还能读的内容都救了出来");
    }

    #[test]
    fn sidecar_and_marker_names_stay_beside_the_main_db() {
        let p = Path::new(r"C:\Users\f\Data\appflowy.db");
        assert_eq!(
            sidecar_path(p, "-wal").to_string_lossy(),
            r"C:\Users\f\Data\appflowy.db-wal"
        );
        let marked = marked_name(p, "corrupt");
        let name = marked.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("appflowy.db.corrupt-"), "{name}");
        assert_eq!(marked.parent(), p.parent());
    }
}
