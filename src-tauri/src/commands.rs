use std::fs;
use std::io::{BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// 自定义 Tauri 命令（项目说明书 9.2：文件读写、导出导入等走 Rust 侧）

const DB_FILE: &str = "appflowy.db";
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
    /// 使 tauri-plugin-sql 的相对路径 `sqlite:appflowy.db` 透明访问自定义位置。
    pub custom_data_dir: Option<String>,
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

pub fn save_config_raw(cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir_raw();
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    fs::write(config_file_path(), s).map_err(|e| format!("write config: {e}"))
}

fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join(CONFIG_DIR_NAME))
        .or_else(|_| Ok(app_config_dir_raw()))
}

fn load_app_config(app: &tauri::AppHandle) -> AppConfig {
    let p = app_config_dir(app)
        .map(|d| d.join(CONFIG_FILE_NAME))
        .unwrap_or_else(|_| config_file_path());
    (|| -> Option<AppConfig> {
        let s = fs::read_to_string(&p).ok()?;
        serde_json::from_str(&s).ok()
    })()
    .unwrap_or_default()
}

fn save_app_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    fs::write(dir.join(CONFIG_FILE_NAME), s).map_err(|e| format!("write config: {e}"))
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
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

fn timestamp_suffix() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{dur}")
}

/// 跨平台在系统文件管理器里打开目录
fn open_path_in_system(path: &Path) -> Result<(), String> {
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
pub fn save_asset(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
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
pub fn save_asset_bytes(app: tauri::AppHandle, bytes: Vec<u8>, ext: String) -> Result<String, String> {
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
    fs::write(assets_dir.join(&file_name), &bytes).map_err(|e| format!("failed to write asset: {e}"))?;
    Ok(format!("{ASSETS_DIR}/{file_name}"))
}

/// 读取任意 UTF-8 文本文件（CSV 导入用；路径来自文件对话框，不受 fs 插件 scope 限制）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// 写入任意 UTF-8 文本文件（CSV 导出用）
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("failed to write {path}: {e}"))
}

// ---------- M6 设置页三个新命令 ----------

/// 返回数据目录绝对路径（显示在设置页里）
#[tauri::command]
pub fn data_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_data_dir(&app)?.to_string_lossy().to_string())
}

/// 在系统文件管理器中打开数据目录
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create data dir: {e}"))?;
    open_path_in_system(&dir)
}

/// 将数据库文件 + assets/ 目录打包为 zip，写到 target_path（由前端文件对话框选）
#[tauri::command]
pub fn export_backup(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
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

    let file = fs::File::create(target)
        .map_err(|e| format!("create backup file failed: {e}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 1. 写入数据库文件（路径即文件名，便于解包后直接对应）
    {
        zip.start_file(DB_FILE, options)
            .map_err(|e| format!("zip start db failed: {e}"))?;
        let mut f = fs::File::open(&db).map_err(|e| format!("open db failed: {e}"))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| format!("read db failed: {e}"))?;
        zip.write_all(&buf).map_err(|e| format!("zip write db failed: {e}"))?;
    }

    // 2. 遍历 assets/
    if assets.is_dir() {
        for entry in WalkDir::new(&assets) {
            let entry = entry.map_err(|e| format!("walk assets failed: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let rel = path.strip_prefix(&data_dir).map_err(|e| format!("strip prefix failed: {e}"))?;
            let name = rel.to_string_lossy().replace('\\', "/");
            zip.start_file(name.clone(), options)
                .map_err(|e| format!("zip start {name} failed: {e}"))?;
            let mut f = fs::File::open(path).map_err(|e| format!("open asset failed: {e}"))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| format!("read asset failed: {e}"))?;
            zip.write_all(&buf).map_err(|e| format!("zip write asset failed: {e}"))?;
        }
    }

    zip.finish().map_err(|e| format!("zip finish failed: {e}"))?;
    Ok(())
}

/// 从 zip 备份恢复：先把现有 db + assets 改名备份（.bak-时间戳），再解 zip 覆盖
#[tauri::command]
pub fn import_backup(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    let data_dir = app_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir: {e}"))?;

    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(format!("backup file not found: {}", src.display()));
    }

    // 前置：备份现有数据（即便失败用户也能手工回滚）
    let suffix = timestamp_suffix();
    let db = data_dir.join(DB_FILE);
    if db.is_file() {
        let bak = data_dir.join(format!("{DB_FILE}.bak-{suffix}"));
        fs::rename(&db, &bak).map_err(|e| format!("backup db failed: {e}"))?;
    }
    let assets_dir = data_dir.join(ASSETS_DIR);
    if assets_dir.is_dir() {
        let bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
        fs::rename(&assets_dir, &bak).map_err(|e| format!("backup assets failed: {e}"))?;
    }

    // 解 zip
    let file = fs::File::open(src).map_err(|e| format!("open backup: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("invalid zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("read zip entry: {e}"))?;
        let name = entry.name().to_string();
        // 安全校验：禁止路径穿越（../），只允许相对路径下的文件名或 assets/xxx
        let rel = Path::new(&name);
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
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
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| format!("read {name}: {e}"))?;
            out.write_all(&buf).map_err(|e| format!("write {name}: {e}"))?;
        }
    }

    // 必须有数据库文件，否则视为恢复失败，不删备份
    let final_db = data_dir.join(DB_FILE);
    if !final_db.is_file() {
        // 回滚：删刚解压出来的，把 bak 改回原名
        let _ = fs::remove_file(&final_db);
        let _ = fs::remove_dir_all(&assets_dir);
        let db_bak = data_dir.join(format!("{DB_FILE}.bak-{suffix}"));
        let assets_bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
        if db_bak.is_file() { let _ = fs::rename(&db_bak, &db); }
        if assets_bak.is_dir() { let _ = fs::rename(&assets_bak, &assets_dir); }
        return Err("backup zip does not contain valid database file".to_string());
    }
    Ok(())
}

// ————————————————————————————————————————————————
// 设置页：自定义数据保存目录（需求2）
// ————————————————————————————————————————————————

#[derive(Serialize)]
pub struct DataDirInfo {
    /// 默认数据目录（Tauri app_data_dir，本次会话生效的实际位置）
    pub default: String,
    /// 用户自定义路径（设置后下次启动生效）
    pub custom: Option<String>,
    /// 是否自定义路径会在下次启动生效
    pub will_change_after_restart: bool,
}

/// 获取当前数据目录信息（展示在设置页）
#[tauri::command]
pub fn get_data_dir_info(app: tauri::AppHandle) -> Result<DataDirInfo, String> {
    let default = app_data_dir(&app)?.to_string_lossy().to_string();
    let cfg = load_app_config(&app);
    let custom = cfg.custom_data_dir.clone();
    let will_change_after_restart = custom
        .as_deref()
        .map(|c| c != default)
        .unwrap_or(false);
    Ok(DataDirInfo {
        default,
        custom,
        will_change_after_restart,
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
#[tauri::command]
pub fn change_data_dir(
    app: tauri::AppHandle,
    new_path: String,
    move_current: bool,
) -> Result<ChangeDataDirResult, String> {
    let default = app_data_dir(&app)?;
    let target = PathBuf::from(&new_path);
    if target.as_os_str().is_empty() {
        return Err("new_path is empty".to_string());
    }
    // 禁止将默认路径本身设为自定义路径（无意义）
    if same_path(&target, &default) {
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

    if move_current {
        // 复制 default 下所有条目到 target
        if default.exists() {
            copy_dir_all(&default, &target)?;
            copied = true;
        }
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

/// 恢复默认数据目录（清除 custom_data_dir；若 move_back=true 则把 custom 下最新数据复制回 default 路径，供下次启动直接读取）
#[tauri::command]
pub fn reset_data_dir_default(
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

    if move_back && custom_pb.exists() {
        // default 若存在先改名为备份（避免用户数据丢失）
        if default.exists() {
            let suf = timestamp_suffix();
            let bak = default
                .parent()
                .map(|p| p.join(format!("tsflowy-data-bak-{suf}")))
                .unwrap_or_else(|| PathBuf::from(format!("./tsflowy-data-bak-{suf}")));
            let _ = fs::rename(&default, &bak);
        }
        let _ = fs::remove_dir_all(&default);
        copy_dir_all(&custom_pb, &default)?;
        copied = true;
    }

    save_app_config(&app, &cfg)?;
    Ok(ChangeDataDirResult {
        need_restart: true,
        copied,
    })
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
        let s = pb.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
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
        let name = e
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase();
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
