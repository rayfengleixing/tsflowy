use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;
use walkdir::WalkDir;

use super::config::{load_app_config, load_config_raw, save_app_config};
use crate::db::Db;

/// 与 tauri.conf.json 的 identifier 保持一致，用于在无 AppHandle 时还原 Tauri 的默认 app_data_dir 路径
const BUNDLE_IDENTIFIER: &str = "com.tsflowy.app";

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

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

pub(crate) fn timestamp_suffix() -> String {
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

/// 判断两个路径是否指向同一位置：canonicalize（会自动展开 junction/symlink）+ 转绝对 + 去尾部斜杠 + 统一小写后比较
pub fn same_path(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> PathBuf {
        let mut pb = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if !pb.is_absolute() {
            if let Ok(cd) = std::env::current_dir() {
                pb = cd.join(&pb);
            }
        }
        let s = pb
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_string()
            .to_lowercase();
        PathBuf::from(s)
    }
    norm(a) == norm(b)
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
}
