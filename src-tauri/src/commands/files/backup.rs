use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::{Db, DB_FILE};

use super::asset::ASSETS_DIR;
use super::auto_backup::{backup_stamp, BACKUP_DIR, PRE_MIGRATION_PREFIX};
use super::config::{config_file_path, CONFIG_FILE_NAME};
use super::data_dir::{app_data_dir, clear_dangling_data_dir_warning, timestamp_suffix};
use super::ensure_dialog_authorized;
use crate::commands::sync::TOMBSTONE_FILE;

/// 将数据库文件 + assets/ 目录 + 旁路文件（设置、附件墓碑清单）打包为 zip，
/// 写到 target_path（由前端文件对话框选）。
/// WAL 模式下直接复制主库文件会丢掉尚未 checkpoint 的事务（appflowy.db-wal），
/// 因此先 VACUUM INTO 出一致性快照（读快照包含全部已提交事务，输出自包含完整库）再打包。
/// 整库压缩 + 全量附件遍历可达数百 MB 的阻塞 IO，放 blocking 线程池执行。
#[tauri::command]
pub async fn export_backup(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_backup_blocking(app, target_path))
        .await
        .map_err(|e| format!("export task failed: {e}"))?
}

fn export_backup_blocking(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
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
        .and_then(|()| write_backup_zip(target, &snap, &data_dir, &assets, BackupScope::Full));
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

/// 归档范围：完整备份（库 + 附件 + 设置/墓碑清单），或只打数据库。
/// 迁移前留档用后者：DDL 不动附件与设置，整份复制既慢、又白占磁盘，
/// 还会把含明文密钥的 config.json 多复制几份。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackupScope {
    Full,
    DatabaseOnly,
}

impl BackupScope {
    /// 写进归档清单的取值（恢复时据此决定动不动附件）
    fn manifest_value(self) -> &'static str {
        match self {
            BackupScope::Full => "full",
            BackupScope::DatabaseOnly => "database_only",
        }
    }
}

/// 归档内的范围元数据条目名。必须显式记下来：迁移留档只装数据库，
/// 而恢复链路默认整库替换 —— 不标注的话，恢复它会把现有 assets/ 挪走，
/// 用户看到的直接后果就是"附件全没了"。
pub(crate) const MANIFEST_ENTRY: &str = "backup-manifest.json";

#[derive(serde::Deserialize)]
struct BackupManifest {
    scope: String,
}

/// 清单文本 → 范围；解析不出来或旧取值一律按完整备份处理
pub(crate) fn scope_from_manifest_text(text: &str) -> BackupScope {
    match serde_json::from_str::<BackupManifest>(text) {
        Ok(m) if m.scope == BackupScope::DatabaseOnly.manifest_value() => BackupScope::DatabaseOnly,
        _ => BackupScope::Full,
    }
}

/// 读取归档声明的范围：没有清单条目（早期归档）一律按完整备份处理，与历史行为一致。
/// 打不开/解析失败同样回落 Full —— 到这里 zip 已通过校验，坏清单只可能是外部改写的，
/// 按更保守的"完整替换"语义处理即可（后面的校验与回滚仍然兜底）。
fn read_backup_scope(src: &Path) -> BackupScope {
    let Ok(file) = fs::File::open(src) else {
        return BackupScope::Full;
    };
    let Ok(mut archive) = ZipArchive::new(BufReader::new(file)) else {
        return BackupScope::Full;
    };
    let Ok(mut entry) = archive.by_name(MANIFEST_ENTRY) else {
        return BackupScope::Full;
    };
    let mut text = String::new();
    match entry.read_to_string(&mut text) {
        Ok(_) => scope_from_manifest_text(&text),
        Err(_) => BackupScope::Full,
    }
}

pub(crate) fn write_backup_zip(
    target: &Path,
    snap: &Path,
    data_dir: &Path,
    assets: &Path,
    scope: BackupScope,
) -> Result<(), String> {
    // 先写同目录临时文件、成功后 rename 覆盖：中途失败不会留下半截 zip
    //（半截 zip 会被自动备份清理逻辑当成"最新一份备份"保留下来，真正需要时才发现坏了）
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_file_name(format!(
        "{}.tmp-{}-{}",
        target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("backup.zip"),
        std::process::id(),
        unique
    ));
    let result = write_backup_zip_to(&tmp, snap, data_dir, assets, scope);
    match result {
        Ok(()) => {
            if target.exists() {
                let _ = fs::remove_file(target);
            }
            fs::rename(&tmp, target).map_err(|e| format!("install backup file failed: {e}"))
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// 除数据库与 assets 外要一并入档的旁路文件：`(zip 条目名, 磁盘路径)`。
/// 磁盘上不存在的直接剔除（没同步过就没有墓碑，从没改过设置也可能没有 config）：
/// - `config.json`：放在数据目录之外的独立配置目录里。缺了它，换机恢复出来的库会配不上
///   原来的数据目录、自动备份与同步设置。**注意**：AI 接口配置含明文 API Key，会跟着进归档。
/// - `deleted-assets.txt`：附件删除墓碑清单，丢了它同步会把对侧已删的附件「复活」。
fn sidecar_entries(data_dir: &Path) -> Vec<(String, PathBuf)> {
    [
        (CONFIG_FILE_NAME.to_string(), config_file_path()),
        (TOMBSTONE_FILE.to_string(), data_dir.join(TOMBSTONE_FILE)),
    ]
    .into_iter()
    .filter(|(_, path)| path.is_file())
    .collect()
}

fn write_backup_zip_to(
    target: &Path,
    snap: &Path,
    data_dir: &Path,
    assets: &Path,
    scope: BackupScope,
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

    // 2. 范围清单：恢复时据此判断"这份归档本来就不含附件"，而不是"附件该被清空"
    zip.start_file(MANIFEST_ENTRY, options)
        .map_err(|e| format!("zip start manifest failed: {e}"))?;
    let manifest = format!("{{\"scope\":\"{}\"}}", scope.manifest_value());
    zip.write_all(manifest.as_bytes())
        .map_err(|e| format!("zip write manifest failed: {e}"))?;

    // 3. 遍历 assets/
    if scope == BackupScope::Full && assets.is_dir() {
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

    // 4. 旁路文件（设置 + 附件墓碑清单）：文件不存在时已在 sidecar_entries 里剔除
    if scope == BackupScope::Full {
        for (name, path) in sidecar_entries(data_dir) {
            zip.start_file(name.clone(), options)
                .map_err(|e| format!("zip start {name} failed: {e}"))?;
            let mut f = fs::File::open(path).map_err(|e| format!("open {name} failed: {e}"))?;
            io::copy(&mut f, &mut zip).map_err(|e| format!("zip write {name} failed: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("zip finish failed: {e}"))?;
    Ok(())
}

/// 迁移前自动留档保留的份数：更早的 DDL 留档既占盘也不会有人回看
const KEEP_PRE_MIGRATION: usize = 3;

/// 跑迁移之前先把当前库留一份可一键恢复的归档：
/// `backups/tsflowy-backup-premigration-<时间戳>-v<版本>.zip`。
/// 迁移是整库唯一的不可逆写操作（DROP/重建表 + 数据规整），一旦失败或事后才发现数据被规整弄坏，
/// 用户手边必须有原件。归档名沿用手动导出前缀，因此直接出现在设置页的备份列表里、走同一条恢复链路。
/// 只打数据库（DatabaseOnly）：DDL 不动附件与设置，整份复制既慢又白占磁盘，
/// 也避免把含明文密钥的 config.json 多复制几份。
pub(crate) fn capture_pre_migration(db: &Path, version: i64) -> Result<PathBuf, String> {
    let data_dir = db
        .parent()
        .ok_or_else(|| "database path has no parent directory".to_string())?;
    let dir = data_dir.join(BACKUP_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create backups dir failed: {e}"))?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let snap = data_dir.join(format!("{DB_FILE}.pre-migration-{nanos}"));
    let target = dir.join(format!(
        "{PRE_MIGRATION_PREFIX}{}-v{version}.zip",
        backup_stamp()
    ));
    let assets = data_dir.join(ASSETS_DIR);
    let outcome = make_db_snapshot(db, &snap).and_then(|()| {
        write_backup_zip(&target, &snap, data_dir, &assets, BackupScope::DatabaseOnly)
    });
    let _ = fs::remove_file(&snap);
    outcome?;
    prune_pre_migration(&dir);
    Ok(target)
}

/// 只保留最新 KEEP_PRE_MIGRATION 份迁移留档。
/// 按文件名排序（时间戳定宽，字典序即时间序）而不是按 mtime：归档被复制/同步后 mtime 会变。
fn prune_pre_migration(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(PRE_MIGRATION_PREFIX) || !name.ends_with(".zip") {
                return None;
            }
            entry.metadata().ok()?.is_file().then_some(name)
        })
        .collect();
    if names.len() <= KEEP_PRE_MIGRATION {
        return;
    }
    names.sort();
    for name in names.iter().take(names.len() - KEEP_PRE_MIGRATION) {
        let _ = fs::remove_file(dir.join(name));
    }
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
    // 校验 + 解压整库与全部附件是重阻塞 IO，放 blocking 线程池执行
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || import_backup_blocking(app, db, source_path))
        .await
        .map_err(|e| format!("import task failed: {e}"))?
}

fn import_backup_blocking(
    app: tauri::AppHandle,
    db: crate::db::SharedDb,
    source_path: String,
) -> Result<(), String> {
    ensure_dialog_authorized(&app, &source_path)?;
    restore_backup_from(&app, db, Path::new(&source_path))
}

/// 把当前 config.json 复制一份进数据目录（与 db/assets 同属 `*.bak-<suffix>` 那一组，
/// 因此 prune_stale_backups 会连着一起清理，不需要另设一套保留策略）。
/// 用复制而不是改名：配置目录在 %APPDATA%，数据目录常被挪到别的盘，跨卷 rename 会失败。
/// 原本没有配置文件时什么都不做——回滚据此删掉刚恢复出来的配置。
fn stash_config_copy(config_target: &Path, data_dir: &Path, suffix: &str) -> Result<(), String> {
    if !config_target.is_file() {
        return Ok(());
    }
    let bak = data_dir.join(format!("{CONFIG_FILE_NAME}.bak-{suffix}"));
    fs::copy(config_target, &bak)
        .map(|_| ())
        .map_err(|e| format!("backup config.json failed: {e}"))
}

/// 恢复主体：关库 → 校验/导入 → 重开。
/// 路径安全性由调用方负责（对话框白名单校验，或 Rust 侧从数据目录内拼好的纯文件名）。
/// 备份列表的「恢复」命令走这里，与「导入备份」完全同一条链路，不另造恢复语义。
pub(crate) fn restore_backup_from(
    app: &tauri::AppHandle,
    db: crate::db::SharedDb,
    source: &Path,
) -> Result<(), String> {
    db.close_for_maintenance()?;
    let result = import_backup_into(&app_data_dir(app)?, source, &config_file_path());
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

/// 导入实现（数据目录与配置文件落点显式传入便于测试）：校验 → stash → 解压 → 失败回滚
fn import_backup_into(data_dir: &Path, src: &Path, config_target: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;

    if !src.is_file() {
        return Err(format!("backup file not found: {}", src.display()));
    }

    // 先校验后破坏：zip 必须能打开、含数据库文件、无路径穿越条目，全部通过才动现有数据。
    // 否则选错文件（非 zip / 无 db）会留下一个"全新空库"，原数据只剩 .bak 且应用内无法恢复。
    validate_backup_zip(src)?;
    // 只装数据库的归档（迁移留档）恢复时不动附件与设置：它们根本不在这份归档里，
    // 按完整替换语义把它们挪走就等于"恢复完成后附件全没了"
    let scope = read_backup_scope(src);

    // 备份现有数据（失败时统一回滚）
    let suffix = timestamp_suffix();
    let db = data_dir.join(DB_FILE);
    let assets_dir = data_dir.join(ASSETS_DIR);
    stash_current_db(&db, &suffix)?;
    if scope == BackupScope::Full && assets_dir.is_dir() {
        let bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
        fs::rename(&assets_dir, &bak).map_err(|e| format!("backup assets failed: {e}"))?;
    }
    // 设置文件与 db/assets 同一时间戳分组：旧版本归档里没有 config.json，
    // stash 后解压也不会写回配置目录，等价于"这次不动设置"
    if scope == BackupScope::Full {
        stash_config_copy(config_target, data_dir, &suffix)?;
    }

    // 解 zip；任何一步失败都回滚到导入前状态（含解压了一半的文件）
    if let Err(e) = extract_backup_zip(src, data_dir, config_target) {
        rollback_import_stash(data_dir, config_target, &suffix, scope);
        return Err(e);
    }
    // 必须有数据库文件，否则视为恢复失败，回滚备份
    if !db.is_file() {
        rollback_import_stash(data_dir, config_target, &suffix, scope);
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

/// 解压备份 zip（写入前再校验一次条目安全；调用方负责失败回滚）。
/// 落点分两处：config.json 回它自己的配置目录，其余条目相对数据目录。
fn extract_backup_zip(src: &Path, data_dir: &Path, config_target: &Path) -> Result<(), String> {
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
        // 只写入数据库、assets/ 下的内容与两个旁路文件，其余条目忽略（更安全）
        let is_db = name == DB_FILE;
        let in_assets = name.starts_with(&format!("{ASSETS_DIR}/")) || name == ASSETS_DIR;
        let is_config = name == CONFIG_FILE_NAME;
        let is_tombstone = name == TOMBSTONE_FILE;
        if !is_db && !in_assets && !is_config && !is_tombstone {
            continue;
        }
        let target = if is_config {
            config_target.to_path_buf()
        } else {
            data_dir.join(rel)
        };
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
fn rollback_import_stash(data_dir: &Path, config_target: &Path, suffix: &str, scope: BackupScope) {
    let db = data_dir.join(DB_FILE);
    let assets_dir = data_dir.join(ASSETS_DIR);
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
    // 只装数据库的归档没有 stash 附件与设置：照 Full 清一遍就会抹掉用户现有的附件
    if scope != BackupScope::Full {
        return;
    }
    // 半解压可能把 assets 写成了文件（条目名撞车），两种形态都要清掉才能把 .bak 目录改回原名
    let _ = fs::remove_dir_all(&assets_dir);
    let _ = fs::remove_file(&assets_dir);
    let assets_bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
    if assets_bak.is_dir() {
        let _ = fs::rename(&assets_bak, &assets_dir);
    }
    // 设置：stash 过就复制回去；导入前本来没有配置文件，就删掉刚解压出来的那份
    let cfg_bak = data_dir.join(format!("{CONFIG_FILE_NAME}.bak-{suffix}"));
    if cfg_bak.is_file() {
        let _ = fs::copy(&cfg_bak, config_target);
    } else {
        let _ = fs::remove_file(config_target);
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
        let cfg = base.join("config").join(CONFIG_FILE_NAME);
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(&cfg, b"{\"keep\":true}").unwrap();

        // 1) 非 zip 文件（用户选错文件）
        let not_zip = base.join("not-a-backup.zip");
        fs::write(&not_zip, b"definitely not a zip").unwrap();
        let err = import_backup_into(&data, &not_zip, &cfg).unwrap_err();
        assert!(err.contains("invalid zip archive"), "{err}");

        // 2) zip 可打开但不含数据库文件
        let no_db = base.join("no-db.zip");
        write_zip(&no_db, &[("assets/pic.png", b"other")]);
        let err = import_backup_into(&data, &no_db, &cfg).unwrap_err();
        assert!(
            err.contains("does not contain valid database file"),
            "{err}"
        );

        // 3) 含路径穿越条目
        let traversal = base.join("traversal.zip");
        write_zip(&traversal, &[("../evil.txt", b"x"), (DB_FILE, b"newdb")]);
        let err = import_backup_into(&data, &traversal, &cfg).unwrap_err();
        assert!(err.contains("path traversal"), "{err}");

        // 关键不变量：三次失败后原数据与设置分毫未动，也没有 .bak 残留（校验先于 stash）
        assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"precious");
        assert_eq!(fs::read(data.join("assets/pic.png")).unwrap(), b"png");
        assert_eq!(fs::read(&cfg).unwrap(), b"{\"keep\":true}");
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

        let cfg = base.join("config").join(CONFIG_FILE_NAME);
        import_backup_into(&data, &good, &cfg).unwrap();

        assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"new-db");
        assert_eq!(fs::read(data.join("assets/new.png")).unwrap(), b"new-asset");
        assert!(!data.join("assets/old.png").exists());
        // 归档里没有 config 条目时，配置目录不该被凭空写出文件
        assert!(!cfg.exists());
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

    #[test]
    fn restore_writes_config_and_tombstones_and_rolls_back_on_failure() {
        let base = std::env::temp_dir().join(format!("tsflowy-sidecar-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let data = base.join("data");
        fs::create_dir_all(data.join("assets")).unwrap();
        fs::write(data.join(DB_FILE), b"old-db").unwrap();
        fs::write(data.join(TOMBSTONE_FILE), b"assets/gone.png\n").unwrap();
        // 配置目录与数据目录分开（真实环境里在 %APPDATA%，数据目录常被挪到别的盘）
        let cfg = base.join("config").join(CONFIG_FILE_NAME);
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(&cfg, b"{\"from\":\"old\"}").unwrap();

        let good = base.join("with-config.zip");
        write_zip(
            &good,
            &[
                (DB_FILE, b"new-db"),
                (CONFIG_FILE_NAME, b"{\"from\":\"new\"}"),
                (TOMBSTONE_FILE, b"assets/other.png\n"),
                ("stray.txt", b"ignored"),
            ],
        );
        import_backup_into(&data, &good, &cfg).unwrap();

        // 三条链路各自落到正确位置；无关条目仍然忽略
        assert_eq!(fs::read(&cfg).unwrap(), b"{\"from\":\"new\"}");
        assert_eq!(
            fs::read(data.join(TOMBSTONE_FILE)).unwrap(),
            b"assets/other.png\n"
        );
        assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"new-db");
        assert!(!data.join("stray.txt").exists());
        // 旧配置以同组 *.bak-<后缀> 存在数据目录：可回滚，也会被 prune_stale_backups 一起清理
        let cfg_bak: Vec<String> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(&format!("{CONFIG_FILE_NAME}.bak-")))
            .collect();
        assert_eq!(cfg_bak.len(), 1, "{cfg_bak:?}");

        // 解压中途失败（`assets` 条目是文件，后续 assets/a.png 无处可写）→ 整体回滚，
        // 配置也要退回本次导入开始前的内容
        let broken = base.join("broken.zip");
        write_zip(
            &broken,
            &[
                (DB_FILE, b"newer-db"),
                (CONFIG_FILE_NAME, b"{\"from\":\"bogus\"}"),
                ("assets", b"not-a-dir"),
                ("assets/a.png", b"x"),
            ],
        );
        let err = import_backup_into(&data, &broken, &cfg).unwrap_err();
        assert!(err.contains("assets/a.png"), "{err}");
        assert_eq!(fs::read(&cfg).unwrap(), b"{\"from\":\"new\"}");
        assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"new-db");
        // 解压时被写成文件的残留 assets 条目要清掉：留在原地下次备份/同步会当目录遍历失败
        // 回滚不能把 assets 留在"文件"形态（下次备份/同步按目录遍历会失败）。
        // 目录形态是合法的：上一轮导入 stash 的 assets.bak 后缀相同（秒级时间戳），回滚把它改回来了
        assert!(!data.join("assets").is_file(), "半解压残留已清除");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn restore_creates_config_on_machine_that_had_none() {
        let base = std::env::temp_dir().join(format!("tsflowy-cfg-none-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let data = base.join("data");
        fs::create_dir_all(&data).unwrap();
        // 配置目录存在但还没有配置文件（换机恢复的常见形态）
        let cfg = base.join("config").join(CONFIG_FILE_NAME);
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();

        let good = base.join("fresh.zip");
        write_zip(
            &good,
            &[(DB_FILE, b"new-db"), (CONFIG_FILE_NAME, b"{\"a\":1}")],
        );
        import_backup_into(&data, &good, &cfg).unwrap();

        assert_eq!(fs::read(&cfg).unwrap(), b"{\"a\":1}");
        let cfg_baks: Vec<String> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(&format!("{CONFIG_FILE_NAME}.bak-")))
            .collect();
        assert!(
            cfg_baks.is_empty(),
            "本机原本没有配置，就不该留下配置的 .bak：{cfg_baks:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// 造一个真实的 SQLite 库文件（capture_pre_migration 走 VACUUM INTO，需要合法库）
    fn make_db_file(path: &Path) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t(x TEXT);
             INSERT INTO t VALUES ('keep-me');",
        )
        .unwrap();
    }

    fn zip_entry_names(path: &Path) -> Vec<String> {
        let file = fs::File::open(path).unwrap();
        let mut archive = ZipArchive::new(BufReader::new(file)).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    #[test]
    fn pre_migration_snapshot_is_database_only_and_restorable() {
        let base = std::env::temp_dir().join(format!("tsflowy-premig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let data = base.join("data");
        fs::create_dir_all(data.join("assets")).unwrap();
        let db = data.join(DB_FILE);
        make_db_file(&db);
        fs::write(data.join("assets/pic.png"), b"png").unwrap();
        let cfg = base.join("config").join(CONFIG_FILE_NAME);
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(&cfg, b"{\"secret\":\"token\"}").unwrap();

        let archive = capture_pre_migration(&db, 18).unwrap();
        assert!(archive.is_file());
        assert!(archive
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(PRE_MIGRATION_PREFIX));
        // 只装数据库 + 范围清单：附件与设置不进（否则明文密钥会被复制多份、留档体积等于整库）
        assert_eq!(
            zip_entry_names(&archive),
            vec![DB_FILE.to_string(), MANIFEST_ENTRY.to_string()]
        );
        validate_backup_zip(&archive).unwrap();

        // 快照是执行时刻的一致状态：原库里的数据在里面
        let unpacked = base.join("unpacked");
        fs::create_dir_all(&unpacked).unwrap();
        let snap = unpacked.join(DB_FILE);
        {
            let file = fs::File::open(&archive).unwrap();
            let mut z = ZipArchive::new(BufReader::new(file)).unwrap();
            let mut e = z.by_name(DB_FILE).unwrap();
            let mut out = fs::File::create(&snap).unwrap();
            io::copy(&mut e, &mut out).unwrap();
        }
        let conn = rusqlite::Connection::open(&snap).unwrap();
        let got: String = conn.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(got, "keep-me");

        // 留档归档走同一条恢复链路（迁移出事后的真正退路）：范围清单让它只换库，
        // 现有附件与设置原地不动 —— 否则"恢复迁移前"会变成"附件全没了"
        import_backup_into(&data, &archive, &cfg).unwrap();
        assert_eq!(fs::read(data.join("assets/pic.png")).unwrap(), b"png");
        assert_eq!(fs::read(&cfg).unwrap(), b"{\"secret\":\"token\"}");
        let stashed: Vec<String> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(&format!("{ASSETS_DIR}.bak-")))
            .collect();
        assert!(stashed.is_empty(), "不该把附件挪走：{stashed:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prune_pre_migration_keeps_newest_three_and_ignores_other_archives() {
        let base =
            std::env::temp_dir().join(format!("tsflowy-premig-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        for stamp in ["20260101-000001", "20260102-000002", "20260103-000003"] {
            fs::write(
                base.join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v1.zip")),
                b"x",
            )
            .unwrap();
        }
        fs::write(
            base.join(format!("{PRE_MIGRATION_PREFIX}20260104-000004-v2.zip")),
            b"x",
        )
        .unwrap();
        fs::write(
            base.join(format!("{PRE_MIGRATION_PREFIX}20260105-000005-v3.zip")),
            b"x",
        )
        .unwrap();
        // 用户手动导出与自动备份的归档不在这次清理的管辖范围
        fs::write(base.join("tsflowy-backup-20260101-0000.zip"), b"keep").unwrap();
        fs::write(base.join("auto-20260101-000000.zip"), b"keep").unwrap();

        prune_pre_migration(&base);

        for stamp in ["20260103-000003", "20260104-000004", "20260105-000005"] {
            assert!(
                base.join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v1.zip"))
                    .is_file()
                    || base
                        .join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v2.zip"))
                        .is_file()
                    || base
                        .join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v3.zip"))
                        .is_file(),
                "保留 {stamp}"
            );
        }
        assert!(
            !base
                .join(format!("{PRE_MIGRATION_PREFIX}20260101-000001-v1.zip"))
                .exists(),
            "最旧两份被清掉"
        );
        assert!(!base
            .join(format!("{PRE_MIGRATION_PREFIX}20260102-000002-v1.zip"))
            .exists());
        assert!(base.join("tsflowy-backup-20260101-0000.zip").is_file());
        assert!(base.join("auto-20260101-000000.zip").is_file());
        let _ = fs::remove_dir_all(&base);
    }
}
