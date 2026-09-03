use std::fs;
use std::io::{BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// 自定义 Tauri 命令（项目说明书 9.2：文件读写、导出导入等走 Rust 侧）

const DB_FILE: &str = "appflowy.db";
const ASSETS_DIR: &str = "assets";

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
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

#[allow(dead_code)]
fn _unused() -> Option<Cursor<Vec<u8>>> {
    // 避免 Cursor / time 导入在某些 target 下出现 dead_code 警告
    let _ = time::macros::format_description!("[year]-[month]-[day]");
    None
}
