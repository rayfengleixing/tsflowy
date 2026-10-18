use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// 导入 Markdown 时收编正文里的远程图片：下载到本机 assets/ 并返回相对路径。
/// 只允许 http/https、响应 Content-Type 必须是已知图片格式、单图上限 20MB；
/// 任何一步失败都由调用方保留原链接（导入不该因为一张图裂了整篇）。
#[tauri::command]
pub async fn fetch_remote_asset(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let checked = check_image_url(&url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;
    let mut resp = client
        .get(&checked)
        .send()
        .await
        .map_err(|e| format!("failed to fetch {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{} returned HTTP {}", url, resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > REMOTE_ASSET_MAX_BYTES as u64 {
            return Err(format!(
                "{url} is {len} bytes, over the {} byte limit",
                REMOTE_ASSET_MAX_BYTES
            ));
        }
    }

    // 只收图片：否则「导入远程图片」会变成「把远端任意文件写进附件目录」的入口
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let ext = image_extension(&content_type, &checked)
        .ok_or_else(|| format!("{url} is not a supported image ({content_type:?})"))?;

    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("failed to read {url}: {e}"))?
    {
        if bytes.len() + chunk.len() > REMOTE_ASSET_MAX_BYTES {
            return Err(format!(
                "{url} exceeds the {} byte limit",
                REMOTE_ASSET_MAX_BYTES
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(format!("{url} returned no bytes"));
    }
    save_asset_bytes(app, bytes, ext).await
}

/// 单张远程图片的大小上限：笔记配图远小于这个数，超了基本是可被诱导的滥用而非用户内容。
const REMOTE_ASSET_MAX_BYTES: usize = 20 * 1024 * 1024;

/// 允许收编的图片格式：`Content-Type` subtype / URL 后缀 → 落盘扩展名。
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "png"),
    ("jpg", "jpg"),
    ("jpeg", "jpg"),
    ("gif", "gif"),
    ("webp", "webp"),
    ("avif", "avif"),
    ("bmp", "bmp"),
    ("tiff", "tiff"),
    ("svg", "svg"),
    ("svg+xml", "svg"),
    ("x-icon", "ico"),
    ("vnd.microsoft.icon", "ico"),
    ("ico", "ico"),
];

fn known_image_extension(raw: &str) -> Option<String> {
    IMAGE_TYPES
        .iter()
        .find(|(from, _)| *from == raw)
        .map(|(_, to)| to.to_string())
}

/// 先看 `Content-Type` 的 subtype，不认识再看 URL 路径后缀；都不在允许表里返回 None。
fn image_extension(content_type: &str, url: &str) -> Option<String> {
    let subtype = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if let Some(rest) = subtype.strip_prefix("image/") {
        if let Some(ext) = known_image_extension(rest) {
            return Some(ext);
        }
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last_segment = path.rsplit('/').next().unwrap_or("");
    let (_, ext) = last_segment.rsplit_once('.')?;
    known_image_extension(&ext.to_ascii_lowercase())
}

/// 校验图片 URL：只放行带主机的 http/https 绝对地址，其余一律拒（防 `file:///`、`gopher:`、相对路径）。
fn check_image_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http(s) image urls can be fetched".to_string());
    }
    let rest = trimmed
        .split_once("://")
        .map(|(_, after)| after)
        .ok_or("invalid image url")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("invalid image url".to_string());
    }
    Ok(trimmed.to_string())
}

/// 把文档里存的 assets 相对路径解析成绝对路径，并确保结果仍在 assets 目录内。
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

/// 读取文本文件（CSV 导入用；路径来自文件对话框）。
/// UTF-8 优先；非 UTF-8 按 GBK 解码回退——中文版 Excel 存出的「CSV」默认就是 GBK，
/// 直接 read_to_string 会报 InvalidData 让用户以为文件坏了。
#[tauri::command]
pub async fn read_text_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    ensure_dialog_authorized(&app, &path)?;
    let bytes = fs::read(&path).map_err(|e| format!("failed to read {path}: {e}"))?;
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(&bytes);
    if had_errors {
        return Err(format!("failed to decode {path}: not valid UTF-8 or GBK"));
    }
    Ok(decoded.into_owned())
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

/// 读取 assets/ 下的字节供 AI 图片附件内联使用。
/// 与 read_asset_bytes 命令同一套越权校验：只认 assets/ 之内的相对路径。
pub(crate) fn load_asset_bytes(app: &tauri::AppHandle, relative: &str) -> Result<Vec<u8>, String> {
    read_asset_bytes_inner(&app_data_dir(app)?, relative)
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
    fn image_extension_prefers_content_type_then_url_suffix() {
        assert_eq!(
            image_extension("image/png", "https://x/a").as_deref(),
            Some("png")
        );
        assert_eq!(
            image_extension("image/jpeg; charset=binary", "https://x/a").as_deref(),
            Some("jpg")
        );
        assert_eq!(
            image_extension("image/svg+xml", "https://x/a").as_deref(),
            Some("svg")
        );
        // Content-Type 含糊时用 URL 后缀兜底；查询串不参与后缀判断
        assert_eq!(
            image_extension("application/octet-stream", "https://x/a/b.WEBP?v=2").as_deref(),
            Some("webp")
        );
        // 两边都不认识 → 拒收
        assert_eq!(image_extension("text/html", "https://x/a.html"), None);
        assert_eq!(image_extension("", "https://x/a"), None);
        assert_eq!(image_extension("", "https://x/a../etc/passwd"), None);
    }

    #[test]
    fn check_image_url_accepts_only_absolute_http_urls() {
        assert_eq!(
            check_image_url("https://cdn.example.com/a.png").as_deref(),
            Ok("https://cdn.example.com/a.png")
        );
        assert!(check_image_url("HTTPS://cdn.example.com/a.png").is_ok());
        assert!(check_image_url("file:///C:/Windows/notepad.exe").is_err());
        assert!(check_image_url("gopher://127.0.0.1:1137/x").is_err());
        assert!(check_image_url("//cdn.example.com/a.png").is_err());
        assert!(check_image_url("https://").is_err());
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
