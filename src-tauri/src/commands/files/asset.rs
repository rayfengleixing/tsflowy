use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::data_dir::app_data_dir;
use super::ensure_dialog_authorized;

pub(crate) const ASSETS_DIR: &str = "assets";

/// 把用户选择的图片复制进数据目录的 assets/ 下，返回相对路径（如 "assets/xxx.png"）。
/// 前端经 asset 协议（convertFileSrc）加载；备份打包 data.db + assets 即可整体迁移。
#[tauri::command]
pub async fn save_asset(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    ensure_dialog_authorized(&app, &source_path)?;
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

/// 读取任意 UTF-8 文本文件（CSV 导入用；路径来自文件对话框）
#[tauri::command]
pub async fn read_text_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    ensure_dialog_authorized(&app, &path)?;
    fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// 写入任意 UTF-8 文本文件（CSV 导出用；路径来自文件对话框）
#[tauri::command]
pub async fn write_text_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    ensure_dialog_authorized(&app, &path)?;
    fs::write(&path, content).map_err(|e| format!("failed to write {path}: {e}"))
}

/// 写入任意二进制文件（长图导出 PNG 用；路径来自文件对话框）
#[tauri::command]
pub async fn write_binary_file(
    app: tauri::AppHandle,
    path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    ensure_dialog_authorized(&app, &path)?;
    fs::write(&path, &bytes).map_err(|e| format!("failed to write {path}: {e}"))
}

/// 递归创建目录（整库导出 Markdown 文件夹用；路径来自目录选择对话框）
#[tauri::command]
pub async fn mkdir_all(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_dialog_authorized(&app, &path)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
