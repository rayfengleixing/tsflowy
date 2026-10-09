use std::fs;
use std::io::{self, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::{Db, DB_FILE};

use super::asset::ASSETS_DIR;
use super::data_dir::{app_data_dir, clear_dangling_data_dir_warning, timestamp_suffix};
use super::ensure_dialog_authorized;

/// 将数据库文件 + assets/ 目录打包为 zip，写到 target_path（由前端文件对话框选）。
/// WAL 模式下直接复制主库文件会丢掉尚未 checkpoint 的事务（appflowy.db-wal），
/// 因此先 VACUUM INTO 出一致性快照（读快照包含全部已提交事务，输出自包含完整库）再打包。
#[tauri::command]
pub async fn export_backup(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
    ensure_dialog_authorized(&app, &target_path)?;
    let data_dir = app_data_dir(&app)?;
    let db = data_dir.join(DB_FILE);
    let assets = data_dir.join(ASSETS_DIR);

    if !db.is_file() {
        return Err(format!("database not found at {}", db.display()));
    }

    let target = Path::new(&target_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent dir failed: {e}"))?;
    }

    // VACUUM INTO 要求目标文件不存在；用纳秒时间戳避免并发导出互相踩踏
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let snap = data_dir.join(format!("{DB_FILE}.export-{nanos}"));

    let outcome = make_db_snapshot(&db, &snap)
        .and_then(|()| write_backup_zip(target, &snap, &data_dir, &assets));
    // 快照用完即删（成功/失败路径都覆盖）
    let _ = fs::remove_file(&snap);
    outcome
}

/// 用独立的只读连接对库做 VACUUM INTO 快照（并发写不受影响，快照内容为执行时刻的一致状态）
pub(crate) fn make_db_snapshot(db: &Path, snap: &Path) -> Result<(), String> {
    let conn =
        rusqlite::Connection::open(db).map_err(|e| format!("open db for snapshot failed: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("set busy timeout failed: {e}"))?;
    conn.execute("VACUUM INTO ?1", [snap.to_string_lossy().as_ref()])
        .map(|_| ())
        .map_err(|e| format!("create db snapshot failed: {e}"))
}

pub(crate) fn write_backup_zip(
    target: &Path,
    snap: &Path,
    data_dir: &Path,
    assets: &Path,
) -> Result<(), String> {
    let file = fs::File::create(target).map_err(|e| format!("create backup file failed: {e}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 1. 写入数据库快照（zip 内路径即文件名，便于解包后直接对应）
    zip.start_file(DB_FILE, options)
        .map_err(|e| format!("zip start db failed: {e}"))?;
    let mut f = fs::File::open(snap).map_err(|e| format!("open db snapshot failed: {e}"))?;
    // 流式拷贝：库+附件可能上百 MB，整份读进内存会顶高峰值占用
    io::copy(&mut f, &mut zip).map_err(|e| format!("zip write db failed: {e}"))?;

    // 2. 遍历 assets/
    if assets.is_dir() {
        for entry in WalkDir::new(assets) {
            let entry = entry.map_err(|e| format!("walk assets failed: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let rel = path
                .strip_prefix(data_dir)
                .map_err(|e| format!("strip prefix failed: {e}"))?;
            let name = rel.to_string_lossy().replace('\\', "/");
            zip.start_file(name.clone(), options)
                .map_err(|e| format!("zip start {name} failed: {e}"))?;
            let mut f = fs::File::open(path).map_err(|e| format!("open asset failed: {e}"))?;
            io::copy(&mut f, &mut zip).map_err(|e| format!("zip write asset failed: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("zip finish failed: {e}"))?;
    Ok(())
}

/// 从 zip 备份恢复：先把现有 db（含 -wal/-shm）+ assets 改名备份（.bak-时间戳），再解 zip 覆盖。
/// 旧 db 的 -wal/-shm 必须一并移走：新恢复的库若被旧 WAL 回放会直接损坏。
/// 恢复前后对 Db 做整体 close/reopen：Windows 下连接未关时主库/-wal 无法改名/覆盖；
/// 也因此不再要求"先关应用再导入"。
#[tauri::command]
pub async fn import_backup(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    source_path: String,
) -> Result<(), String> {
    ensure_dialog_authorized(&app, &source_path)?;
    db.close_for_maintenance()?;
    let result = import_backup_inner(app, &source_path);
    match result {
        Ok(()) => {
            // 导入成功即数据目录已重建（悬空联接被 create_dir_all 治好），告警随之失效
            clear_dangling_data_dir_warning();
            db.reopen()
        }
        // 失败路径也重开：恢复失败时应用应继续可用（原数据仍在 .bak 或原位）
        Err(e) => {
            let _ = db.reopen();
            Err(e)
        }
    }
}

fn import_backup_inner(app: tauri::AppHandle, source_path: &str) -> Result<(), String> {
    let data_dir = app_data_dir(&app)?;
    import_backup_into(&data_dir, Path::new(source_path))
}

/// 导入实现（数据目录显式传入便于测试）：校验 → stash → 解压 → 失败回滚
fn import_backup_into(data_dir: &Path, src: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;

    if !src.is_file() {
        return Err(format!("backup file not found: {}", src.display()));
    }

    // 先校验后破坏：zip 必须能打开、含数据库文件、无路径穿越条目，全部通过才动现有数据。
    // 否则选错文件（非 zip / 无 db）会留下一个"全新空库"，原数据只剩 .bak 且应用内无法恢复。
    validate_backup_zip(src)?;

    // 备份现有数据（失败时统一回滚）
    let suffix = timestamp_suffix();
    let db = data_dir.join(DB_FILE);
    let assets_dir = data_dir.join(ASSETS_DIR);
    stash_current_db(&db, &suffix)?;
    if assets_dir.is_dir() {
        let bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
        fs::rename(&assets_dir, &bak).map_err(|e| format!("backup assets failed: {e}"))?;
    }

    // 解 zip；任何一步失败都回滚到导入前状态（含解压了一半的文件）
    if let Err(e) = extract_backup_zip(src, data_dir) {
        rollback_import_stash(data_dir, &suffix);
        return Err(e);
    }
    // 必须有数据库文件，否则视为恢复失败，回滚备份
    if !db.is_file() {
        rollback_import_stash(data_dir, &suffix);
        return Err(format!(
            "backup zip does not contain valid database file (previous data kept at *.bak-{suffix})"
        ));
    }
    // 恢复成功：清掉更早的历史备份（导入会不断产生 .bak-*，不清理会无限堆积）
    prune_stale_backups(data_dir);
    Ok(())
}

/// 保留的历史备份组数（同一次导入产生的 db/assets 备份后缀相同，算一组）
const KEEP_BAK_GROUPS: usize = 3;

/// 清理数据目录里过期的 `*.bak-<时间戳>` 备份，只留最新 KEEP_BAK_GROUPS 组。
/// 纯增益动作：目录读不了、条目名不合规、删除失败都静默跳过，绝不因此中断主流程。
fn prune_stale_backups(data_dir: &Path) {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return;
    };
    let mut items: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // 形如 appflowy.db.bak-1730000000、appflowy.db.bak-1730000000-wal、assets.bak-1730000000
        let Some(suffix) = name.rsplit_once(".bak-").map(|(_, s)| s) else {
            continue;
        };
        let Some(stamp) = suffix.split('-').next().and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        items.push((stamp, entry.path()));
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.0)); // 新的在前
    let mut kept: Vec<u64> = Vec::new();
    for (stamp, path) in items {
        if kept.contains(&stamp) {
            continue; // 同组的其余文件跟着这一组一起留
        }
        if kept.len() < KEEP_BAK_GROUPS {
            kept.push(stamp);
            continue;
        }
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 导入前置校验（不写任何文件）：能打开、无路径穿越条目、含数据库文件
fn validate_backup_zip(src: &Path) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("invalid zip archive: {e}"))?;
    let mut has_db = false;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry: {e}"))?;
        let name = entry.name().to_string();
        let rel = Path::new(&name);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("invalid zip entry (path traversal): {name}"));
        }
        if name == DB_FILE {
            has_db = true;
        }
    }
    if !has_db {
        return Err("backup zip does not contain valid database file".to_string());
    }
    Ok(())
}

/// 解压备份 zip 到数据目录（写入前再校验一次条目安全；调用方负责失败回滚）
fn extract_backup_zip(src: &Path, data_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("invalid zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry: {e}"))?;
        let name = entry.name().to_string();
        // 安全校验：禁止路径穿越（../），只允许相对路径下的文件名或 assets/xxx
        let rel = Path::new(&name);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("invalid zip entry (path traversal): {name}"));
        }
        let target = data_dir.join(rel);
        // 只写入根目录文件（应是 DB_FILE）或以 assets/ 开头的内容
        let in_assets = name.starts_with(&format!("{ASSETS_DIR}/")) || name == ASSETS_DIR;
        let is_db = name == DB_FILE;
        if !is_db && !in_assets {
            continue; // 忽略 zip 里无关条目（更安全）
        }
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("mkdir {name}: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("mkdir parent {name}: {e}"))?;
            }
            let mut out = fs::File::create(&target).map_err(|e| format!("write {name}: {e}"))?;
            // 流式解压：单个附件可能很大，整份读进内存没有意义
            io::copy(&mut entry, &mut out).map_err(|e| format!("write {name}: {e}"))?;
        }
    }
    Ok(())
}

/// 回滚导入：清掉可能解压出的 db/assets，再把 stash 的 .bak 改回原名（含 -wal/-shm 侧车）
fn rollback_import_stash(data_dir: &Path, suffix: &str) {
    let db = data_dir.join(DB_FILE);
    let assets_dir = data_dir.join(ASSETS_DIR);
    let _ = fs::remove_dir_all(&assets_dir);
    // 半解压出的新库必须清掉：Windows 下 rename 不能覆盖已存在文件，留着会让 .bak 还原失败
    let _ = fs::remove_file(&db);
    let db_bak = data_dir.join(format!("{DB_FILE}.bak-{suffix}"));
    if db_bak.is_file() {
        let _ = fs::rename(&db_bak, &db);
    }
    for ext in ["-wal", "-shm"] {
        let from = data_dir.join(format!("{DB_FILE}.bak-{suffix}{ext}"));
        let to = data_dir.join(format!("{DB_FILE}{ext}"));
        if from.is_file() {
            let _ = fs::rename(&from, &to);
        }
    }
    let assets_bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
    if assets_bak.is_dir() {
        let _ = fs::rename(&assets_bak, &assets_dir);
    }
}

/// 把旧 db 的 -wal/-shm 改名到 .bak-{suffix} 同名后缀。
/// 存在的文件改名失败必须中止：新恢复的库若被旧 WAL 回放会直接损坏。
fn move_db_sidecars_to_bak(db: &Path, suffix: &str) -> Result<(), String> {
    for ext in ["-wal", "-shm"] {
        let from = db.with_file_name(format!("{DB_FILE}{ext}"));
        if !from.is_file() {
            continue;
        }
        let to = db.with_file_name(format!("{DB_FILE}.bak-{suffix}{ext}"));
        fs::rename(&from, &to).map_err(|e| format!("move old db{ext} away failed: {e}"))?;
    }
    Ok(())
}

/// 把当前 db 改名到 .bak-{suffix}，-wal/-shm 一并移走（新库绝不能继承旧 WAL，否则被错误回放损坏）。
/// 先 best-effort `wal_checkpoint(TRUNCATE)`：让 .bak 主文件尽量自包含（用户常单独拷走 .bak 文件）。
/// 注意：SQLite 打开/关闭库文件时可能会自行清理残留的 wal/shm，因此侧车文件是"被移走或被清掉"皆可，
/// 不变量只有一个——stash 结束后原名 wal/shm 不复存在。
pub(crate) fn stash_current_db(db: &Path, suffix: &str) -> Result<(), String> {
    let wal = db.with_file_name(format!("{DB_FILE}-wal"));
    let shm = db.with_file_name(format!("{DB_FILE}-shm"));
    if !db.is_file() {
        // 无主库文件时的孤儿 wal/shm 直接清掉（无法回放，留着会污染新库）
        let _ = fs::remove_file(&wal);
        let _ = fs::remove_file(&shm);
        return Ok(());
    }
    if let Ok(conn) = rusqlite::Connection::open(db) {
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)", []);
    }
    let bak = db.with_file_name(format!("{DB_FILE}.bak-{suffix}"));
    fs::rename(db, &bak).map_err(|e| {
        format!("backup db failed (data dir may be in use; retry after closing the app): {e}")
    })?;
    // 与主库同生共死：移走失败必须中止，否则解压出的新库会撞上旧 WAL
    move_db_sidecars_to_bak(db, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn prune_stale_backups_keeps_newest_groups_only() {
        let base = std::env::temp_dir().join(format!("tsflowy-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("data");
        fs::create_dir_all(&dir).unwrap();

        // 4 次导入的残留：db + assets 各一组（后缀 = 秒级时间戳，越大越新）
        for stamp in ["100", "200", "300", "400"] {
            fs::write(dir.join(format!("{DB_FILE}.bak-{stamp}")), b"x").unwrap();
            fs::create_dir_all(dir.join(format!("{ASSETS_DIR}.bak-{stamp}"))).unwrap();
        }
        // 同组的侧车文件：跟组走，不单独计数
        fs::write(dir.join(format!("{DB_FILE}.bak-400-wal")), b"x").unwrap();
        // 不合规名字：不认识就不动
        fs::write(dir.join("notes.txt"), b"keep").unwrap();
        fs::write(dir.join("weird.bak-abc"), b"keep").unwrap();

        prune_stale_backups(&dir);

        for stamp in ["400", "300", "200"] {
            assert!(
                dir.join(format!("{DB_FILE}.bak-{stamp}")).is_file(),
                "保留 {stamp}"
            );
            assert!(
                dir.join(format!("{ASSETS_DIR}.bak-{stamp}")).is_dir(),
                "保留 {stamp} 的 assets"
            );
        }
        assert!(
            dir.join(format!("{DB_FILE}.bak-400-wal")).is_file(),
            "同组侧车跟着保留"
        );
        assert!(
            !dir.join(format!("{DB_FILE}.bak-100")).exists(),
            "最旧一组被清掉"
        );
        assert!(!dir.join(format!("{ASSETS_DIR}.bak-100")).exists());
        assert!(dir.join("notes.txt").is_file());
        assert!(dir.join("weird.bak-abc").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stash_moves_db_sidecars_to_bak() {
        let base =
            std::env::temp_dir().join(format!("tsflowy-stash-{}-sidecars", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("data");
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join(DB_FILE);
        fs::write(&db, b"main").unwrap();
        fs::write(dir.join(format!("{DB_FILE}-wal")), b"wal-bytes").unwrap();
        fs::write(dir.join(format!("{DB_FILE}-shm")), b"shm-bytes").unwrap();

        move_db_sidecars_to_bak(&db, "77").unwrap();

        assert_eq!(
            fs::read(dir.join(format!("{DB_FILE}.bak-77-wal"))).unwrap(),
            b"wal-bytes"
        );
        assert_eq!(
            fs::read(dir.join(format!("{DB_FILE}.bak-77-shm"))).unwrap(),
            b"shm-bytes"
        );
        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
        assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stash_current_db_leaves_no_stale_wal_next_to_new_db() {
        // 伪造非 SQLite 主库 + 残留 wal/shm。SQLite 打开/关闭时可能自行清掉侧车文件，
        // 也可能留给 move_db_sidecars_to_bak 改名——两者皆可；不变量是 stash 结束后
        // 原名 wal/shm 不复存在（否则解压出的新库会被旧 WAL 回放损坏）。
        let base = std::env::temp_dir().join(format!("tsflowy-stash-{}-e2e", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("data");
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join(DB_FILE);
        fs::write(&db, b"main").unwrap();
        fs::write(dir.join(format!("{DB_FILE}-wal")), b"wal-bytes").unwrap();
        fs::write(dir.join(format!("{DB_FILE}-shm")), b"shm-bytes").unwrap();

        stash_current_db(&db, "77").unwrap();

        assert_eq!(
            fs::read(dir.join(format!("{DB_FILE}.bak-77"))).unwrap(),
            b"main"
        );
        assert!(!db.exists());
        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
        assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stash_current_db_clears_orphan_wal_shm_when_db_missing() {
        let base =
            std::env::temp_dir().join(format!("tsflowy-stash-{}-orphan", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("data");
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join(DB_FILE);
        fs::write(dir.join(format!("{DB_FILE}-wal")), b"stale").unwrap();
        fs::write(dir.join(format!("{DB_FILE}-shm")), b"stale").unwrap();

        stash_current_db(&db, "88").unwrap();

        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
        assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
        // 无主库时不应产生 bak 文件
        assert!(!dir.join(format!("{DB_FILE}.bak-88")).exists());
        let _ = fs::remove_dir_all(&base);
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = FileOptions::default();
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn import_backup_rejects_bad_source_without_touching_data() {
        let base = std::env::temp_dir().join(format!("tsflowy-import-{}-bad", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let data = base.join("data");
        fs::create_dir_all(data.join("assets")).unwrap();
        fs::write(data.join(DB_FILE), b"precious").unwrap();
        fs::write(data.join("assets/pic.png"), b"png").unwrap();

        // 1) 非 zip 文件（用户选错文件）
        let not_zip = base.join("not-a-backup.zip");
        fs::write(&not_zip, b"definitely not a zip").unwrap();
        let err = import_backup_into(&data, &not_zip).unwrap_err();
        assert!(err.contains("invalid zip archive"), "{err}");

        // 2) zip 可打开但不含数据库文件
        let no_db = base.join("no-db.zip");
        write_zip(&no_db, &[("assets/pic.png", b"other")]);
        let err = import_backup_into(&data, &no_db).unwrap_err();
        assert!(
            err.contains("does not contain valid database file"),
            "{err}"
        );

        // 3) 含路径穿越条目
        let traversal = base.join("traversal.zip");
        write_zip(&traversal, &[("../evil.txt", b"x"), (DB_FILE, b"newdb")]);
        let err = import_backup_into(&data, &traversal).unwrap_err();
        assert!(err.contains("path traversal"), "{err}");

        // 关键不变量：三次失败后原数据分毫未动，也没有 .bak 残留（校验先于 stash）
        assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"precious");
        assert_eq!(fs::read(data.join("assets/pic.png")).unwrap(), b"png");
        let leftovers: Vec<String> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".bak-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "unexpected .bak leftovers: {leftovers:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn import_backup_replaces_data_and_keeps_previous_as_bak() {
        let base = std::env::temp_dir().join(format!("tsflowy-import-{}-ok", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let data = base.join("data");
        fs::create_dir_all(data.join("assets")).unwrap();
        fs::write(data.join(DB_FILE), b"old-db").unwrap();
        fs::write(data.join("assets/old.png"), b"old-asset").unwrap();

        let good = base.join("good.zip");
        write_zip(
            &good,
            &[(DB_FILE, b"new-db"), ("assets/new.png", b"new-asset")],
        );

        import_backup_into(&data, &good).unwrap();

        assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"new-db");
        assert_eq!(fs::read(data.join("assets/new.png")).unwrap(), b"new-asset");
        assert!(!data.join("assets/old.png").exists());
        let names: Vec<String> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names
                .iter()
                .any(|n| n.starts_with(&format!("{DB_FILE}.bak-"))),
            "{names:?}"
        );
        assert!(
            names
                .iter()
                .any(|n| n.starts_with(&format!("{ASSETS_DIR}.bak-"))),
            "{names:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }
}
