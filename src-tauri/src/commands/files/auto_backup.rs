use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use zip::ZipArchive;

use crate::db::{Db, DB_FILE};

use super::asset::ASSETS_DIR;
use super::backup::{
    make_db_snapshot, restore_backup_from, scope_from_manifest_text, write_backup_zip, BackupScope,
    MANIFEST_ENTRY,
};
use super::config::{load_app_config, save_app_config, AutoBackupConfig, CONFIG_FILE_NAME};
use super::data_dir::{open_path_in_system, real_data_dir};
use crate::commands::sync::TOMBSTONE_FILE;

/// 自动备份落点子目录（数据目录下），与 assets/ 平级
pub(crate) const BACKUP_DIR: &str = "backups";
/// 自动备份文件名前缀（用于与用户手动导出的 zip 区分、以及清理时筛选）
const AUTO_BACKUP_PREFIX: &str = "auto-";
/// 设置页「导出备份」默认文件名的前缀（tsflowy-backup-YYYYMMDD-HHMM.zip）；
/// 用户手动导出到 backups/ 目录的归档同样进备份列表
const MANUAL_BACKUP_PREFIX: &str = "tsflowy-backup-";
/// 迁移前自动留档的归档名前缀（以 MANUAL_BACKUP_PREFIX 开头，因此直接出现在备份列表里可一键恢复）
pub(crate) const PRE_MIGRATION_PREFIX: &str = "tsflowy-backup-premigration-";

/// 自动备份目录：数据目录下 backups/
pub(crate) fn backup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(real_data_dir(app)?.join(BACKUP_DIR))
}

/// 文件名里的本地时间戳：auto-YYYYMMDD-HHMMSS.zip（取不到本地时区时退回 Unix 秒）
pub(crate) fn backup_stamp() -> String {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    const FMT: &[time::format_description::FormatItem<'_>] =
        time::macros::format_description!("[year][month][day]-[hour][minute][second]");
    now.format(FMT)
        .unwrap_or_else(|_| now.unix_timestamp().to_string())
}

/// 打包一份自动备份到 backups/auto-<时间戳>.zip，并保留最新 keep 份。
/// 复用 export_backup 的快照链路（WAL 下直接拷主库会丢未 checkpoint 的事务）。
pub fn run_auto_backup(app: &tauri::AppHandle, keep: usize) -> Result<PathBuf, String> {
    let data_dir = real_data_dir(app)?;
    let db = data_dir.join(DB_FILE);
    if !db.is_file() {
        return Err(format!("database not found at {}", db.display()));
    }
    let assets = data_dir.join(ASSETS_DIR);
    let dir = data_dir.join(BACKUP_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create backup dir failed: {e}"))?;

    let target = dir.join(format!("{AUTO_BACKUP_PREFIX}{}.zip", backup_stamp()));
    // 同一秒内重复触发（如刚开机 + 手动点「立即备份」）直接覆盖，避免留下半成品
    let _ = fs::remove_file(&target);

    let snap = data_dir.join(format!("{DB_FILE}.auto-{}", std::process::id()));
    let _ = fs::remove_file(&snap);
    let outcome = make_db_snapshot(&db, &snap)
        .and_then(|()| write_backup_zip(&target, &snap, &data_dir, &assets, BackupScope::Full));
    let _ = fs::remove_file(&snap);
    outcome?;

    prune_auto_backups(&dir, keep);
    Ok(target)
}

/// 列出 backups/ 下的自动备份文件，按修改时间倒序（新的在前）。目录不存在时返回空表。
fn auto_backup_files(dir: &Path) -> Vec<(String, PathBuf, SystemTime)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<(String, PathBuf, SystemTime)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(AUTO_BACKUP_PREFIX) || !name.ends_with(".zip") {
                return None;
            }
            let mtime = entry.metadata().ok()?.modified().ok()?;
            Some((name, entry.path(), mtime))
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.2));
    items
}

/// backups/ 下最新的一份自动备份（文件名、路径、修改时间）
pub(crate) fn latest_auto_backup(dir: &Path) -> Option<(String, PathBuf, SystemTime)> {
    auto_backup_files(dir).into_iter().next()
}

/// 只保留 backups/ 下最新的 keep 份自动备份（按修改时间倒序），多余删除。
/// 纯增益动作：任何失败都静默跳过，不影响本次备份结果。
fn prune_auto_backups(dir: &Path, keep: usize) {
    for (_, path, _) in auto_backup_files(dir).into_iter().skip(keep) {
        let _ = fs::remove_file(&path);
    }
}

/// 距最近一次自动备份已过去的时长（秒）；从未备份过返回 None
fn secs_since_last_auto_backup(app: &tauri::AppHandle) -> Result<Option<u64>, String> {
    Ok(latest_auto_backup(&backup_dir(app)?).map(|(_, _, t)| {
        SystemTime::now()
            .duration_since(t)
            .unwrap_or_default()
            .as_secs()
    }))
}

/// 后台调度一次判定：开启且距上次备份已超过间隔（或从未备份）时执行一次自动备份。
pub fn maybe_run_auto_backup(app: &tauri::AppHandle) {
    let cfg = load_app_config(app).auto_backup.normalized();
    if !cfg.enabled {
        return;
    }
    let interval_secs = cfg.interval_hours * 3600;
    match secs_since_last_auto_backup(app) {
        Ok(Some(elapsed)) if elapsed < interval_secs => return, // 未到点
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = %e, "auto backup: resolve backup dir failed");
            return;
        }
    }
    match run_auto_backup(app, cfg.keep) {
        Ok(p) => tracing::info!(path = %p.display(), "auto backup created"),
        Err(e) => tracing::warn!(error = %e, "auto backup failed"),
    }
}

#[derive(Serialize)]
pub struct AutoBackupInfo {
    /// 当前设置（normalized 之后的有效值）
    pub enabled: bool,
    pub interval_hours: u64,
    pub keep: usize,
    /// backups/ 目录绝对路径（展示 / 打开用）
    pub dir: String,
    /// 最近一次自动备份时间（本地时间字符串），从未备份为 None
    pub last_backup: Option<String>,
}

/// 把 SystemTime 格式化为**本地**时间串（设置页与诊断页共用）。
/// 注意不能直接 format(OffsetDateTime::from(t))——那是 UTC，会比本地时间小 8 小时。
pub(crate) fn format_local_time(t: SystemTime) -> String {
    const FMT: &[time::format_description::FormatItem<'_>] =
        time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    let utc = time::OffsetDateTime::from(t);
    time::UtcOffset::current_local_offset()
        .map(|off| utc.to_offset(off))
        .unwrap_or(utc)
        .format(FMT)
        .unwrap_or_else(|_| "—".to_string())
}

/// 读取自动备份设置 + 目录 + 最近备份时间（设置页展示）
#[tauri::command]
pub fn get_auto_backup_config(app: tauri::AppHandle) -> Result<AutoBackupInfo, String> {
    let cfg = load_app_config(&app).auto_backup.normalized();
    let dir = backup_dir(&app)?;
    let last_backup = latest_auto_backup(&dir).map(|(_, _, t)| format_local_time(t));
    Ok(AutoBackupInfo {
        enabled: cfg.enabled,
        interval_hours: cfg.interval_hours,
        keep: cfg.keep,
        dir: dir.to_string_lossy().to_string(),
        last_backup,
    })
}

/// 写入自动备份设置（前端只传变更后的完整三项）
#[tauri::command]
pub fn set_auto_backup_config(
    app: tauri::AppHandle,
    enabled: bool,
    interval_hours: u64,
    keep: usize,
) -> Result<AutoBackupInfo, String> {
    let mut cfg = load_app_config(&app);
    cfg.auto_backup = AutoBackupConfig {
        enabled,
        interval_hours,
        keep,
    };
    save_app_config(&app, &cfg)?;
    // 关闭自动备份时，已存在的历史备份保留不动（由用户自行在目录里清理）
    get_auto_backup_config(app)
}

/// 立即备份一次（设置页按钮）：走与自动备份完全相同的链路
#[tauri::command]
pub async fn run_auto_backup_now(app: tauri::AppHandle) -> Result<String, String> {
    // VACUUM INTO + 全量 zip 是重阻塞 IO，放 blocking 线程池执行
    tauri::async_runtime::spawn_blocking(move || {
        let keep = load_app_config(&app).auto_backup.normalized().keep;
        run_auto_backup(&app, keep).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("backup task failed: {e}"))?
}

/// backups/ 里的一份备份归档
#[derive(Serialize)]
pub struct BackupArchive {
    pub name: String,
    pub size: u64,
    /// 修改时间（本地时间串）
    pub modified: String,
    /// 修改时间（epoch 毫秒）：两种命名模式的文件名互排序，前端按此排序
    pub mtime_ms: u64,
}

/// 备份归档文件名的准入判定：只认自动备份与手动导出两种命名，且必须是纯文件名
/// （restore_backup 用它拒绝任何带路径成分的名字，与 restore_sync_conflict 同思路）
fn is_backup_archive_name(name: &str) -> bool {
    !name.is_empty()
        && name.ends_with(".zip")
        && (name.starts_with(AUTO_BACKUP_PREFIX) || name.starts_with(MANUAL_BACKUP_PREFIX))
        && Path::new(name).file_name().and_then(|s| s.to_str()) == Some(name)
}

/// 列出备份归档（按修改时间新→旧）。目录不存在时返回空表。
/// 以磁盘为准：被改名/被清理删除的文件自然不会出现在列表里。
pub(crate) fn list_backup_archives(dir: &Path) -> Vec<BackupArchive> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<(SystemTime, BackupArchive)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_backup_archive_name(&name) {
                return None;
            }
            let m = entry.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            let t = m.modified().ok()?;
            Some((
                t,
                BackupArchive {
                    name,
                    size: m.len(),
                    modified: format_local_time(t),
                    mtime_ms: t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                },
            ))
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.0));
    items.into_iter().map(|(_, a)| a).collect()
}

/// 列出备份归档（设置页「备份列表」）。目录 IO 很轻但要与其它重 IO 命令一致走 blocking 池。
#[tauri::command]
pub async fn list_backups(app: tauri::AppHandle) -> Result<Vec<BackupArchive>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = backup_dir(&app)?;
        Ok(list_backup_archives(&dir))
    })
    .await
    .map_err(|e| format!("list backups task failed: {e}"))?
}

/// 在系统文件管理器里打开备份目录（不存在则先建出来）
#[tauri::command]
pub fn open_backups_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = backup_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create backups dir failed: {e}"))?;
    open_path_in_system(&dir)
}

/// 用 backups/ 里的一份归档恢复本机数据：与「导入备份」完全同一条链路
/// （关库 → 校验 → stash 现有数据 → 解压 → 重开），只是路径由 Rust 侧从备份目录内拼接，
/// 不依赖文件对话框白名单。成功后前端必须重载窗口（本机库已被替换）。
#[tauri::command]
pub async fn restore_backup(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    name: String,
) -> Result<(), String> {
    if !is_backup_archive_name(&name) {
        return Err(format!("invalid backup name: {name}"));
    }
    let path = backup_dir(&app)?.join(&name);
    if !path.is_file() {
        return Err(format!("backup file not found: {name}"));
    }
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || restore_backup_from(&app, db, &path))
        .await
        .map_err(|e| format!("restore task failed: {e}"))?
}

/// 归档内容摘要（设置页「预览内容」用）：只读 zip 的中央目录，不解压、不碰本机数据。
/// 逐条列文件对几百个附件没有意义，用户真正要判断的是"这份里有没有我要的东西"。
#[derive(Debug, Serialize)]
pub struct BackupArchiveInfo {
    pub entry_count: usize,
    pub has_database: bool,
    /// 是否含 config.json：早期版本的归档没有，恢复时不会改动设置
    pub has_config: bool,
    /// 是否含附件删除墓碑清单：没有它对侧同步可能把已删附件复活
    pub has_tombstones: bool,
    pub asset_count: usize,
    /// 是否只装数据库（迁移前自动留档）：这类归档不含附件与设置，恢复时也不会动它们
    pub database_only: bool,
    /// 解压后所需字节数（条目未压缩大小之和），恢复前估个空间
    pub unpacked_bytes: u64,
}

/// 读归档中央目录做摘要（路径由调用方从备份目录内拼好，纯文件名）
pub(crate) fn summarize_backup_archive(path: &Path) -> Result<BackupArchiveInfo, String> {
    let file = fs::File::open(path).map_err(|e| format!("open backup failed: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("invalid zip archive: {e}"))?;
    let mut info = BackupArchiveInfo {
        entry_count: archive.len(),
        has_database: false,
        has_config: false,
        has_tombstones: false,
        database_only: false,
        asset_count: 0,
        unpacked_bytes: 0,
    };
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry: {e}"))?;
        let name = entry.name().to_string();
        if name == DB_FILE {
            info.has_database = true;
        } else if name == CONFIG_FILE_NAME {
            info.has_config = true;
        } else if name == TOMBSTONE_FILE {
            info.has_tombstones = true;
        } else if name == MANIFEST_ENTRY {
            let mut text = String::new();
            if entry.read_to_string(&mut text).is_ok() {
                info.database_only = scope_from_manifest_text(&text) == BackupScope::DatabaseOnly;
            }
        } else if name.starts_with(&format!("{ASSETS_DIR}/")) && !entry.is_dir() {
            info.asset_count += 1;
        }
        info.unpacked_bytes = info.unpacked_bytes.saturating_add(entry.size());
    }
    Ok(info)
}

/// 预览某份备份归档的内容（不写任何文件）
#[tauri::command]
pub async fn inspect_backup_archive(
    app: tauri::AppHandle,
    name: String,
) -> Result<BackupArchiveInfo, String> {
    if !is_backup_archive_name(&name) {
        return Err(format!("invalid backup name: {name}"));
    }
    let path = backup_dir(&app)?.join(&name);
    tauri::async_runtime::spawn_blocking(move || summarize_backup_archive(&path))
        .await
        .map_err(|e| format!("inspect backup task failed: {e}"))?
}

/// 删除 backups/ 里的一份归档。名字沿用 restore_backup 的准入判定：
/// 只接受两种备份命名的纯文件名，前端二次确认后才调用。
#[tauri::command]
pub async fn delete_backup_archive(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !is_backup_archive_name(&name) {
        return Err(format!("invalid backup name: {name}"));
    }
    let path = backup_dir(&app)?.join(&name);
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_file() {
            return Err(format!("backup file not found: {}", path.display()));
        }
        fs::remove_file(&path).map_err(|e| format!("delete backup failed: {e}"))
    })
    .await
    .map_err(|e| format!("delete backup task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    /// 造一份最小归档：条目名 → 内容
    fn make_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = FileOptions::default();
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zip, bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn summarize_reports_which_parts_the_archive_carries() {
        let base = std::env::temp_dir().join(format!("tsflowy-inspect-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("auto-x.zip");
        make_archive(
            &zip_path,
            &[
                (DB_FILE, b"db-bytes"),
                (CONFIG_FILE_NAME, b"{\"a\":1}"),
                (TOMBSTONE_FILE, b"assets/gone.png\n"),
                ("assets/a.png", b"12345"),
                ("assets/b.png", b"67890"),
            ],
        );

        let info = summarize_backup_archive(&zip_path).unwrap();
        assert_eq!(info.entry_count, 5);
        assert!(info.has_database);
        assert!(info.has_config, "新版归档应带设置");
        assert!(info.has_tombstones);
        assert!(!info.database_only, "没有范围清单一律按完整备份");
        assert_eq!(info.asset_count, 2);
        assert_eq!(
            info.unpacked_bytes,
            8 + 7 + 16 + 5 + 5,
            "解压后所需总字节（各条目未压缩大小之和）"
        );

        // 旧版归档（只有库 + 附件）：预览应如实显示"不含设置"，恢复时不会动配置
        let legacy = base.join("auto-legacy.zip");
        make_archive(&legacy, &[(DB_FILE, b"db"), ("assets/a.png", b"x")]);
        let info = summarize_backup_archive(&legacy).unwrap();
        assert!(info.has_database && !info.has_config && !info.has_tombstones);

        // 迁移前留档：范围清单声明只装数据库，预览据此提示而不是报"不含设置"警告
        let pre = base.join("auto-pre.zip");
        make_archive(
            &pre,
            &[
                (DB_FILE, b"db"),
                (MANIFEST_ENTRY, br#"{"scope":"database_only"}"#),
            ],
        );
        let info = summarize_backup_archive(&pre).unwrap();
        assert!(info.database_only);
        assert!(!info.has_config && info.asset_count == 0);

        // 非 zip 文件：明确报错，不能返回一个"空归档"
        let junk = base.join("auto-junk.zip");
        fs::write(&junk, b"not a zip").unwrap();
        assert!(summarize_backup_archive(&junk)
            .unwrap_err()
            .contains("invalid zip archive"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn backup_name_filter_accepts_only_known_patterns() {
        assert!(is_backup_archive_name("auto-20261001-120000.zip"));
        assert!(is_backup_archive_name("tsflowy-backup-20261001-1200.zip"));
        assert!(!is_backup_archive_name("notes.txt"));
        assert!(!is_backup_archive_name("random.zip"));
        assert!(!is_backup_archive_name("auto-x.zip.tmp-1-2"));
        assert!(!is_backup_archive_name("../auto-x.zip"));
        assert!(!is_backup_archive_name("sub\\auto-x.zip"));
        assert!(!is_backup_archive_name(""));
    }

    #[test]
    fn list_backup_archives_sorts_newest_first_and_filters() {
        let base =
            std::env::temp_dir().join(format!("tsflowy-list-backups-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // mtime 新→旧：auto-old 最老、auto-new 最新；非备份命名与目录形态都不进列表
        fs::write(base.join("auto-old.zip"), b"old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(base.join("tsflowy-backup-mid.zip"), b"mid").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(base.join("auto-new.zip"), b"newer").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(base.join("junk.zip"), b"junk").unwrap();
        fs::create_dir_all(base.join("auto-dir.zip")).unwrap();

        let got = list_backup_archives(&base);
        let names: Vec<&str> = got.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["auto-new.zip", "tsflowy-backup-mid.zip", "auto-old.zip"],
            "按 mtime 新→旧，且只含两种备份命名"
        );
        assert_eq!(got[0].size, 5);
        assert!(got[0].mtime_ms > 0);
        assert!(list_backup_archives(&base.join("nope")).is_empty());
        let _ = fs::remove_dir_all(&base);
    }
}
