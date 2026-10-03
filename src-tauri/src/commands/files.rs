use std::fs;
use std::io::{self, BufReader, BufWriter, Cursor};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::{Db, DB_FILE};

// 自定义 Tauri 命令（项目说明书 9.2：文件读写、导出导入等走 Rust 侧）
//
// 注：涉及磁盘读写的命令一律声明为 async。Tauri 的同步命令跑在主线程上，
// 打包备份/解压导入/整库目录复制这类秒级 I/O 会卡住 UI；async 命令在运行时线程池执行。

const ASSETS_DIR: &str = "assets";
/// 存放 config.json 的独立子目录名（放在 config 系统目录下，避免被"重命名默认数据目录为备份"一起搬走）
const CONFIG_DIR_NAME: &str = "TsFlowyConfig";
const CONFIG_FILE_NAME: &str = "config.json";
/// 与 tauri.conf.json 的 identifier 保持一致，用于在无 AppHandle 时还原 Tauri 的默认 app_data_dir 路径
const BUNDLE_IDENTIFIER: &str = "com.tsflowy.app";

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    /// 用户自定义数据目录（Windows/macOS/Linux 跨平台绝对路径）。
    /// 下一次启动时会把默认 app_data_dir 建为指向该路径的 junction/symlink，
    /// 使 app_data_dir（数据库、assets 等全部落点）透明访问自定义位置。
    pub custom_data_dir: Option<String>,
    /// 自动备份设置（旧 config.json 无此字段时取默认值）
    #[serde(default)]
    pub auto_backup: AutoBackupConfig,
    /// 双向同步设置与上次同步基线（旧 config.json 无此字段时取默认值）
    #[serde(default)]
    pub sync: SyncConfig,
}

/// 双向同步（#13）：把数据目录里的库 + assets 与一个「同步文件夹」对齐。
/// 同步文件夹由用户指定（OneDrive/坚果云等网盘客户端的本地文件夹、或映射到 WebDAV 的盘符），
/// 实际数据放在其下的 TsFlowySync/ 子目录，避免与用户其它文件混在一起。
///
/// 这里只保存「本机视角」的状态：上次同步时两侧库的指纹。它是判断
/// "谁改过" 的基线——没有基线的第一次同步按修改时间取新者，旧的留冲突副本。
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct SyncConfig {
    /// 用户选择的同步文件夹（空/None = 未开启同步）
    #[serde(default)]
    pub dir: Option<String>,
    /// 上次同步完成时库的 sha256（两侧已一致，同一个值）
    #[serde(default)]
    pub last_hash: Option<String>,
    /// 上次同步做了什么：none / upload / download / conflict
    #[serde(default)]
    pub last_action: Option<String>,
    /// 上次同步时间（本地时间串）
    #[serde(default)]
    pub last_time: Option<String>,
}

/// 自动备份设置。默认开启：每 24 小时打包一次 data.db 快照 + assets/ 到数据目录下的 backups/。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AutoBackupConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 两次自动备份的最小间隔（小时），下限 1
    #[serde(default = "default_interval_hours")]
    pub interval_hours: u64,
    /// backups/ 目录中保留的自动备份份数，多余按时间倒序删除
    #[serde(default = "default_keep")]
    pub keep: usize,
}

fn default_true() -> bool {
    true
}

fn default_interval_hours() -> u64 {
    24
}

fn default_keep() -> usize {
    7
}

impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            keep: 7,
        }
    }
}

impl AutoBackupConfig {
    /// 后台线程只读该配置判断是否到点，字段可能被前端写入任意值，这里统一夹到安全范围
    fn normalized(&self) -> Self {
        Self {
            enabled: self.enabled,
            interval_hours: self.interval_hours.clamp(1, 24 * 30),
            keep: self.keep.clamp(1, 100),
        }
    }
}

/// 独立于 AppHandle 的 config 目录解析（给 lib.rs 在 Builder.plugin() 之前调用）。
/// 放在系统 config 目录下的"TsFlowyConfig"子目录，与默认数据目录物理独立，
/// 保证"把默认数据目录重命名为备份"时，config.json 不会被一并搬走。
pub fn app_config_dir_raw() -> PathBuf {
    fn home() -> PathBuf {
        std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
    let base = if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".config"))
    };
    base.join(CONFIG_DIR_NAME)
}

/// 独立于 AppHandle 的 default app_data_dir 解析，与 Tauri v2 默认策略保持一致：
/// Windows = %APPDATA%\<identifier>, macOS = ~/Library/Application Support/<identifier>,
/// Linux = $XDG_DATA_HOME/<identifier>（identifier = com.tsflowy.app，来自 tauri.conf.json）。
pub fn default_data_dir_raw() -> PathBuf {
    fn home() -> PathBuf {
        std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
    let base = if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".local").join("share"))
    };
    base.join(BUNDLE_IDENTIFIER)
}

pub fn config_file_path() -> PathBuf {
    app_config_dir_raw().join(CONFIG_FILE_NAME)
}

pub fn load_config_raw() -> AppConfig {
    let p = config_file_path();
    (|| -> Option<AppConfig> {
        let s = fs::read_to_string(&p).ok()?;
        serde_json::from_str(&s).ok()
    })()
    .unwrap_or_default()
}

fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join(CONFIG_DIR_NAME))
        .or_else(|_| Ok(app_config_dir_raw()))
}

pub(crate) fn load_app_config(app: &tauri::AppHandle) -> AppConfig {
    let p = app_config_dir(app)
        .map(|d| d.join(CONFIG_FILE_NAME))
        .unwrap_or_else(|_| config_file_path());
    (|| -> Option<AppConfig> {
        let s = fs::read_to_string(&p).ok()?;
        serde_json::from_str(&s).ok()
    })()
    .unwrap_or_default()
}

pub(crate) fn save_app_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    // 同目录临时文件 + rename 覆盖：磁盘上的 config.json 任何时刻要么是旧完整内容、要么是新完整内容，
    // 不会因写一半崩溃/断电留下半截 JSON（损坏会被 load_app_config 静默回落默认值，自定义目录等设置就“丢了”）
    let tmp = dir.join(format!("{CONFIG_FILE_NAME}.tmp"));
    fs::write(&tmp, s).map_err(|e| format!("write config: {e}"))?;
    fs::rename(&tmp, dir.join(CONFIG_FILE_NAME)).map_err(|e| format!("replace config: {e}"))
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

/// 数据目录的真实落点：默认目录若是指向别处的 junction/symlink（自定义目录），
/// 返回其目标路径，供设置页展示与路径比较；否则返回目录本身。
pub fn real_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?;
    match fs::read_link(&dir) {
        Ok(target) => Ok(strip_verbatim_prefix(target)),
        Err(_) => Ok(dir),
    }
}

/// 去掉 Windows read_link 可能带上的 `\\?\` 前缀（否则路径展示很难看）
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// 启动时发现「数据目录联接悬空」（联接条目还在、目标被外部删除）时记下的丢失路径。
/// 兜底页据此明确告知用户数据目录曾丢失，避免应用静默建出空库、让人误以为数据凭空消失。
static DANGLING_DATA_DIR: Mutex<Option<String>> = Mutex::new(None);

/// 由 lib.rs 在启动自检发现悬空联接时调用（见 lib.rs bootstrap_data_dir）
pub fn set_dangling_data_dir_warning(lost: &Path) {
    let p = strip_verbatim_prefix(lost.to_path_buf());
    *DANGLING_DATA_DIR.lock().unwrap() = Some(p.to_string_lossy().to_string());
}

/// 本次启动是否存在悬空联接告警
pub fn dangling_data_dir_warning() -> Option<String> {
    DANGLING_DATA_DIR.lock().unwrap().clone()
}

/// 目录已重建（用户确认重建或导入备份成功）后清除告警
pub fn clear_dangling_data_dir_warning() {
    *DANGLING_DATA_DIR.lock().unwrap() = None;
}

/// 本次启动实际使用的数据落点，与 lib.rs bootstrap_data_dir 口径一致：自定义目录优先，否则 app_data_dir 真实目录
pub fn target_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    match load_config_raw().custom_data_dir {
        Some(c) => Ok(PathBuf::from(c)),
        None => app_data_dir(app),
    }
}

/// 目录整体复制：所有条目从 src 复制到 dst（dst 若不存在则创建）。若 dst 下已存在同名文件且 non_empty=true 则报错。
pub fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("src not found: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| format!("mkdir dst: {e}"))?;
    for entry in WalkDir::new(src).min_depth(1) {
        let entry = entry.map_err(|e| format!("walk src: {e}"))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| format!("strip prefix: {e}"))?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::copy(entry.path(), &target)
                .map_err(|e| format!("copy {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

/// 把 src 下的顶层条目迁移到 dst：dst 已存在同名条目则跳过（绝不覆盖目标已有数据）。
/// 优先 rename（同盘瞬间完成），跨盘 rename 失败时回退为「复制后删除」。
/// 用于把旧数据目录整体搬到新的默认位置（文档\TsFlowy）。
pub fn migrate_dir_entries(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir dst: {e}"))?;
    let entries = fs::read_dir(src).map_err(|e| format!("read src dir {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if to.exists() {
            continue; // 目标已有同名条目：保留目标数据
        }
        if fs::rename(&from, &to).is_ok() {
            continue;
        }
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
            fs::remove_dir_all(&from).map_err(|e| format!("remove migrated dir: {e}"))?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
            fs::remove_file(&from).map_err(|e| format!("remove migrated file: {e}"))?;
        }
    }
    Ok(())
}

fn timestamp_suffix() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{dur}")
}

/// 跨平台在系统文件管理器里打开目录
pub(crate) fn open_path_in_system(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("failed to open explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("failed to open: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("failed to xdg-open: {e}"))?;
    }
    let _ = path;
    Ok(())
}

/// 把用户选择的图片复制进数据目录的 assets/ 下，返回相对路径（如 "assets/xxx.png"）。
/// 前端经 asset 协议（convertFileSrc）加载；备份打包 data.db + assets 即可整体迁移。
#[tauri::command]
pub async fn save_asset(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    let data_dir = app_data_dir(&app)?;
    let assets_dir = data_dir.join(ASSETS_DIR);
    fs::create_dir_all(&assets_dir).map_err(|e| format!("failed to create assets dir: {e}"))?;

    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(format!("source file not found: {source_path}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "bin".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_name = format!("{nanos}.{ext}");
    fs::copy(src, assets_dir.join(&file_name)).map_err(|e| format!("failed to copy asset: {e}"))?;
    Ok(format!("{ASSETS_DIR}/{file_name}"))
}

/// 保存前端传入的字节流到 assets 目录（用于编辑器粘贴/拖拽图片上传，省去写临时文件）。
/// 返回相对路径 `assets/{nanos}.{ext}`，前端用 `resolveAssetUrl` 转可加载 URL。
#[tauri::command]
pub async fn save_asset_bytes(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let data_dir = app_data_dir(&app)?;
    let assets_dir = data_dir.join(ASSETS_DIR);
    fs::create_dir_all(&assets_dir).map_err(|e| format!("failed to create assets dir: {e}"))?;

    // 规范扩展名：只允许字母数字且最长 5 位，避免恶意路径注入；默认 bin
    let ext = ext.trim().to_lowercase();
    let ext = if ext.chars().all(|c| c.is_alphanumeric()) && ext.len() <= 5 {
        ext
    } else {
        "bin".to_string()
    };

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_name = format!("{nanos}.{ext}");
    fs::write(assets_dir.join(&file_name), &bytes)
        .map_err(|e| format!("failed to write asset: {e}"))?;
    Ok(format!("{ASSETS_DIR}/{file_name}"))
}

/// 把文档里存的 assets 相对路径解析成绝对路径，并确保结果仍在 assets 目录内。
/// 文档内容可被导入/编辑，因此这里假定 `relative` 不可信：绝对路径、`..`、
/// 以及经符号链接/junction 逃逸出 assets 目录的目标一律拒绝。
fn resolve_asset_path(data_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    use std::ffi::OsStr;
    use std::path::Component;

    let rel = Path::new(relative);
    let mut comps = rel.components();
    if comps.next() != Some(Component::Normal(OsStr::new(ASSETS_DIR))) {
        return Err("only paths under assets/ can be opened".to_string());
    }
    if comps.any(|c| !matches!(c, Component::Normal(_))) {
        return Err("invalid asset path".to_string());
    }

    let assets_dir = data_dir.join(ASSETS_DIR);
    let assets_root = assets_dir
        .canonicalize()
        .map_err(|e| format!("failed to resolve assets dir: {e}"))?;
    let sub = rel
        .strip_prefix(ASSETS_DIR)
        .map_err(|_| "only paths under assets/ can be opened".to_string())?;
    let target = assets_root
        .join(sub)
        .canonicalize()
        .map_err(|_| format!("asset file not found: {relative}"))?;
    if !target.starts_with(&assets_root) {
        return Err("asset path escapes the assets directory".to_string());
    }
    Ok(target)
}

/// 用系统默认程序打开 assets/ 下的附件（附件卡片点击入口）。
#[tauri::command]
pub fn open_asset(app: tauri::AppHandle, relative: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = resolve_asset_path(&app_data_dir(&app)?, &relative)?;
    app.opener()
        .open_path(target.display().to_string(), None::<&str>)
        .map_err(|e| format!("failed to open asset: {e}"))
}

/// 读取任意 UTF-8 文本文件（CSV 导入用；路径来自文件对话框，不受 fs 插件 scope 限制）
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// 写入任意 UTF-8 文本文件（CSV 导出用）
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("failed to write {path}: {e}"))
}

/// 写入任意二进制文件（长图导出 PNG 用；路径来自文件对话框）
#[tauri::command]
pub async fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &bytes).map_err(|e| format!("failed to write {path}: {e}"))
}

/// 递归创建目录（整库导出 Markdown 文件夹用；路径来自目录选择对话框，不受 fs 插件 scope 限制）
#[tauri::command]
pub async fn mkdir_all(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("failed to create dir {path}: {e}"))
}

/// 读取 assets/ 下文件的字节（长图/PDF 导出把图片内联为 data URL 用，绕开 asset 协议跨源抓取）。
#[tauri::command]
pub async fn read_asset_bytes(app: tauri::AppHandle, relative: String) -> Result<Vec<u8>, String> {
    read_asset_bytes_inner(&app_data_dir(&app)?, &relative)
}

fn read_asset_bytes_inner(data_dir: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let target = resolve_asset_path(data_dir, relative)?;
    fs::read(&target).map_err(|e| format!("failed to read asset: {e}"))
}

// ---------- M6 设置页三个新命令 ----------

/// 返回数据目录绝对路径（显示在设置页里）：默认目录经 junction 落到自定义目录时展示真实落点
#[tauri::command]
pub fn data_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(real_data_dir(&app)?.to_string_lossy().to_string())
}

/// 在系统文件管理器中打开数据目录
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = real_data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create data dir: {e}"))?;
    open_path_in_system(&dir)
}

/// 将数据库文件 + assets/ 目录打包为 zip，写到 target_path（由前端文件对话框选）。
/// WAL 模式下直接复制主库文件会丢掉尚未 checkpoint 的事务（appflowy.db-wal），
/// 因此先 VACUUM INTO 出一致性快照（读快照包含全部已提交事务，输出自包含完整库）再打包。
#[tauri::command]
pub async fn export_backup(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
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

fn write_backup_zip(
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
    if let Err(e) = extract_backup_zip(src, &data_dir) {
        rollback_import_stash(&data_dir, &suffix);
        return Err(e);
    }
    // 必须有数据库文件，否则视为恢复失败，回滚备份
    if !db.is_file() {
        rollback_import_stash(&data_dir, &suffix);
        return Err(format!(
            "backup zip does not contain valid database file (previous data kept at *.bak-{suffix})"
        ));
    }
    // 恢复成功：清掉更早的历史备份（导入会不断产生 .bak-*，不清理会无限堆积）
    prune_stale_backups(&data_dir);
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
    items.sort_by(|a, b| b.0.cmp(&a.0)); // 新的在前
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

// ————————————————————————————————————————————————
// 设置页：自定义数据保存目录（需求2）
// ————————————————————————————————————————————————

#[derive(Serialize)]
pub struct DataDirInfo {
    /// 当前实际生效的数据目录（默认目录经联接落到自定义目录后的真实位置）
    pub default: String,
    /// 用户自定义路径（设置后下次启动生效）
    pub custom: Option<String>,
    /// 是否自定义路径会在下次启动生效
    pub will_change_after_restart: bool,
    /// 默认目录（Tauri app_data_dir）是否为指向别处的目录联接（junction/symlink）
    pub is_linked: bool,
    /// 目录联接所在路径（即系统默认数据目录，如 %APPDATA%\com.tsflowy.app）
    pub link_path: String,
}

/// 获取当前数据目录信息（展示在设置页）
#[tauri::command]
pub fn get_data_dir_info(app: tauri::AppHandle) -> Result<DataDirInfo, String> {
    let link = app_data_dir(&app)?;
    let default = real_data_dir(&app)?.to_string_lossy().to_string();
    let cfg = load_app_config(&app);
    let custom = cfg.custom_data_dir.clone();
    let will_change_after_restart = custom.as_deref().map(|c| c != default).unwrap_or(false);
    let is_linked = fs::symlink_metadata(&link)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    Ok(DataDirInfo {
        default,
        custom,
        will_change_after_restart,
        is_linked,
        link_path: link.to_string_lossy().to_string(),
    })
}

#[derive(Serialize)]
pub struct ChangeDataDirResult {
    pub need_restart: bool,
    /// 迁移了多少个条目（文件+目录），为 0 表示用户勾选"不要迁移数据，留空目录开始"
    pub copied: bool,
}

/// 修改数据保存位置：(1) 把现有 default data_dir 条目复制到 new_path；(2) 写入 config custom_data_dir；
/// 下次启动会把 default app_data_dir 建成指向 new_path 的 junction/symlink，SQL 插件相对路径即透明生效。
/// move_current 拷贝运行中的数据目录前先整体关闭连接（WAL 未 checkpoint 时直接拷会拿到旧主库/半截 WAL），
/// 拷完或出错都立即重开，应用继续在原目录工作到重启。
#[tauri::command]
pub async fn change_data_dir(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    new_path: String,
    move_current: bool,
) -> Result<ChangeDataDirResult, String> {
    let default = app_data_dir(&app)?;
    let real_default = real_data_dir(&app)?;
    let target = PathBuf::from(&new_path);
    if target.as_os_str().is_empty() {
        return Err("new_path is empty".to_string());
    }
    // 禁止将默认路径本身（含 junction 落到「文档\TsFlowy」的真实位置）设为自定义路径（无意义）
    if same_path(&target, &default) || same_path(&target, &real_default) {
        return Err("new_path cannot equal the default data dir".to_string());
    }
    // 禁止将自定义路径设置为默认路径的祖先（会导致 junction 死循环）
    if default.starts_with(&target) {
        return Err("new_path cannot be a parent of the default data dir".to_string());
    }

    let mut copied = false;
    // 创建目标目录（如果不存在）
    fs::create_dir_all(&target).map_err(|e| format!("create target dir: {e}"))?;
    // 目标目录必须为空（或只含 .DS_Store / Thumbs.db 这类无伤害条目），否则拒绝
    if !is_dir_safely_empty(&target)? {
        return Err("target directory must be empty".to_string());
    }

    if move_current && default.exists() {
        // 先 checkpoint 并关闭连接再逐文件拷贝：否则拷到的 data.db 可能不含 WAL 里未落库的事务
        db.close_for_maintenance()?;
        let copy_result = copy_dir_all(&default, &target);
        // 无论拷贝成败都恢复连接（失败时应用继续用旧目录，与拷贝前一致）
        let reopen_result = db.reopen();
        copy_result?;
        reopen_result?;
        copied = true;
    }

    // 写 config
    let mut cfg = load_app_config(&app);
    cfg.custom_data_dir = Some(target.to_string_lossy().to_string());
    save_app_config(&app, &cfg)?;

    Ok(ChangeDataDirResult {
        need_restart: true,
        copied,
    })
}

/// 恢复默认数据目录（清除 custom_data_dir；若 move_back=true 则把 custom 下最新数据复制回 default 路径，供下次启动直接读取）。
/// move_back 会改名/替换 default 目录 → 前后对 Db 做整体 close/reopen（应用运行中即可完成）。
#[tauri::command]
pub async fn reset_data_dir_default(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    move_back: bool,
) -> Result<ChangeDataDirResult, String> {
    // 未设置 custom 时无文件操作，直接返回，不动数据库连接
    if load_app_config(&app).custom_data_dir.is_none() {
        return Ok(ChangeDataDirResult {
            need_restart: false,
            copied: false,
        });
    }
    db.close_for_maintenance()?;
    let result = reset_data_dir_default_inner(app, move_back);
    match result {
        Ok(r) => db.reopen().map(|()| r),
        Err(e) => {
            let _ = db.reopen();
            Err(e)
        }
    }
}

fn reset_data_dir_default_inner(
    app: tauri::AppHandle,
    move_back: bool,
) -> Result<ChangeDataDirResult, String> {
    let mut cfg = load_app_config(&app);
    let Some(custom) = cfg.custom_data_dir.take() else {
        return Ok(ChangeDataDirResult {
            need_restart: false,
            copied: false,
        });
    };
    let default = app_data_dir(&app)?;
    let custom_pb = PathBuf::from(&custom);
    let mut copied = false;

    // 自定义目录模式下 default 是指向 custom 的联接：先摘掉联接条目（只删联接、不动 custom 数据），
    // 再把 custom 数据复制回真实 default 目录。
    if move_back && custom_pb.exists() {
        let suf = timestamp_suffix();
        let bak = default
            .parent()
            .map(|p| p.join(format!("tsflowy-appdata-bak-{suf}")))
            .unwrap_or_else(|| PathBuf::from(format!("./tsflowy-appdata-bak-{suf}")));
        if fs::symlink_metadata(&default)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            fs::remove_dir(&default)
                .or_else(|_| fs::remove_file(&default))
                .map_err(|e| format!("remove data dir link failed: {e}"))?;
        }
        restore_custom_to_default(&default, &custom_pb, &bak)?;
        copied = true;
    }

    save_app_config(&app, &cfg)?;
    Ok(ChangeDataDirResult {
        need_restart: true,
        copied,
    })
}

// ————————————————————————————————————————————————
// 自动备份：按间隔打包 data.db 快照 + assets/ 到数据目录下的 backups/
// ————————————————————————————————————————————————

/// 自动备份落点子目录（数据目录下），与 assets/ 平级
const BACKUP_DIR: &str = "backups";
/// 自动备份文件名前缀（用于与用户手动导出的 zip 区分、以及清理时筛选）
const AUTO_BACKUP_PREFIX: &str = "auto-";

/// 自动备份目录：数据目录下 backups/
fn backup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
        .and_then(|()| write_backup_zip(&target, &snap, &data_dir, &assets));
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
    items.sort_by(|a, b| b.2.cmp(&a.2));
    items
}

/// backups/ 下最新的一份自动备份（文件名、路径、修改时间）
fn latest_auto_backup(dir: &Path) -> Option<(String, PathBuf, SystemTime)> {
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
    let keep = load_app_config(&app).auto_backup.normalized().keep;
    run_auto_backup(&app, keep).map(|p| p.to_string_lossy().to_string())
}

// ————————————————————————————————————————————————
// 数据库健康诊断：数据库不可用时的兜底提示页
// ————————————————————————————————————————————————

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

/// 把 custom 数据恢复为 default 路径：先将现有 default 整体改名到 bak，再把 custom 复制回来。
/// rename 失败必须中止（Windows 下数据库连接未关时目录改名很常见地失败）——
/// 绝不允许吞掉错误继续删除/覆盖 default，那会无备份清掉用户数据。rename 成功后 default 已不存在，无需删除。
fn restore_custom_to_default(default: &Path, custom: &Path, bak: &Path) -> Result<(), String> {
    if default.exists() {
        fs::rename(default, bak).map_err(|e| {
            format!(
                "backup default data dir failed (data dir may be in use; retry after closing the app): {e}"
            )
        })?;
    }
    copy_dir_all(custom, default)?;
    Ok(())
}

/// 判断两个路径是否指向同一位置（规范化后比较）
fn same_path(a: &Path, b: &Path) -> bool {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    fn norm(p: &Path) -> Option<PathBuf> {
        let mut pb = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if !pb.is_absolute() {
            pb = std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(&pb);
        }
        // 去除末尾分隔符
        let s = pb
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_string();
        Some(PathBuf::from(s))
    }
    let (x, y) = (norm(a), norm(b));
    match (x, y) {
        (Some(x), Some(y)) => {
            let h = |p: &Path| -> u64 {
                let mut s = DefaultHasher::new();
                p.to_string_lossy().to_lowercase().hash(&mut s);
                s.finish()
            };
            h(&x) == h(&y)
        }
        _ => false,
    }
}

/// 判断目录是否"安全为空"：不存在 / 空 / 只有 .DS_Store、Thumbs.db 这类忽略项。
fn is_dir_safely_empty(dir: &Path) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(true);
    }
    if !dir.is_dir() {
        return Err("target is not a directory".to_string());
    }
    for e in fs::read_dir(dir).map_err(|e| format!("read_dir target: {e}"))? {
        let e = e.map_err(|e| format!("entry: {e}"))?;
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        if matches!(name.as_str(), ".ds_store" | "thumbs.db" | "desktop.ini") {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

#[allow(dead_code)]
fn _unused() -> Option<Cursor<Vec<u8>>> {
    // 避免 Cursor / time 导入在某些 target 下出现 dead_code 警告
    let _ = time::macros::format_description!("[year]-[month]-[day]");
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_case(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("tsflowy-reset-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let default = base.join("default");
        let custom = base.join("custom");
        let bak = base.join("bak");
        fs::create_dir_all(default.join("assets")).unwrap();
        fs::create_dir_all(custom.join("assets")).unwrap();
        (base, default, custom, bak)
    }

    #[test]
    fn resolve_asset_path_accepts_real_file_under_assets() {
        let (base, default, ..) = temp_case("asset-ok");
        fs::write(default.join("assets/123.pdf"), b"x").unwrap();

        let got = resolve_asset_path(&default, "assets/123.pdf").unwrap();
        assert!(got.starts_with(default.join("assets").canonicalize().unwrap()));
        assert!(got.is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_asset_path_rejects_absolute_and_foreign_prefix() {
        let (base, default, ..) = temp_case("asset-prefix");
        fs::write(default.join("assets/123.pdf"), b"x").unwrap();

        assert!(resolve_asset_path(&default, r"C:\Windows\notepad.exe").is_err());
        assert!(resolve_asset_path(&default, "/etc/passwd").is_err());
        assert!(resolve_asset_path(&default, "appflowy.db").is_err());
        assert!(resolve_asset_path(&default, "").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn read_asset_bytes_reads_real_file_and_rejects_foreign_paths() {
        let (base, default, ..) = temp_case("asset-read");
        fs::write(default.join("assets/pic.png"), b"\x89PNG-bytes").unwrap();

        assert_eq!(
            read_asset_bytes_inner(&default, "assets/pic.png").unwrap(),
            b"\x89PNG-bytes"
        );
        // 越权/穿越路径一律拒绝，且不会读出 assets 之外的文件
        assert!(read_asset_bytes_inner(&default, "appflowy.db").is_err());
        assert!(read_asset_bytes_inner(&default, "assets/../appflowy.db").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_asset_path_rejects_traversal_and_missing_file() {
        let (base, default, ..) = temp_case("asset-traversal");
        fs::write(default.join("appflowy.db"), b"secret").unwrap();
        fs::write(default.join("assets/123.pdf"), b"x").unwrap();

        // .. 组件即使以 assets/ 开头也拒绝
        assert!(resolve_asset_path(&default, "assets/../appflowy.db").is_err());
        assert!(resolve_asset_path(&default, "assets/sub/../../appflowy.db").is_err());
        // 不存在的文件干净报错，不返回可供打开的空路径
        assert!(resolve_asset_path(&default, "assets/missing.pdf").is_err());
        // 关键不变量：库文件仍在原位
        assert_eq!(fs::read(default.join("appflowy.db")).unwrap(), b"secret");
        let _ = fs::remove_dir_all(&base);
    }

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
    fn restore_aborts_and_keeps_default_intact_when_rename_fails() {
        let (base, default, custom, bak) = temp_case("fail");
        fs::write(default.join("appflowy.db"), b"precious").unwrap();
        fs::write(custom.join("appflowy.db"), b"new").unwrap();
        // 预先占用 bak 位置且非空：rename 必然失败（Windows/POSIX 行为一致）
        fs::create_dir_all(bak.join("occupied")).unwrap();

        let err = restore_custom_to_default(&default, &custom, &bak).unwrap_err();
        assert!(err.contains("backup default data dir failed"), "{err}");
        // 关键不变量：rename 失败 → default 数据原封不动
        assert_eq!(fs::read(default.join("appflowy.db")).unwrap(), b"precious");
        // custom 也未被改动（不产生混合数据）
        assert_eq!(fs::read(custom.join("appflowy.db")).unwrap(), b"new");
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

    #[test]
    fn restore_moves_default_to_bak_then_copies_custom() {
        let (base, default, custom, bak) = temp_case("ok");
        fs::write(default.join("appflowy.db"), b"old").unwrap();
        fs::write(custom.join("appflowy.db"), b"new").unwrap();
        fs::write(custom.join("assets").join("a.png"), b"img").unwrap();

        restore_custom_to_default(&default, &custom, &bak).unwrap();

        // default 现在是 custom 的内容；旧数据完整保留在 bak
        assert_eq!(fs::read(default.join("appflowy.db")).unwrap(), b"new");
        assert_eq!(
            fs::read(default.join("assets").join("a.png")).unwrap(),
            b"img"
        );
        assert_eq!(fs::read(bak.join("appflowy.db")).unwrap(), b"old");
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
