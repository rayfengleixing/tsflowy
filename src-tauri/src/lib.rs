mod commands;
mod db;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;
use tracing_subscriber::{fmt, EnvFilter};

/// 启动前：若用户设置了 custom_data_dir，把 default data dir 目录重命名为备份后，
/// 建成指向 custom 的 junction/symlink，使 Rust 侧 Db::open 的相对路径 `sqlite:appflowy.db`
/// 透明落到 custom_data_dir 下。
fn bootstrap_custom_data_dir() {
    let cfg = commands::files::load_config_raw();
    let Some(custom) = cfg.custom_data_dir.clone() else {
        return;
    };
    let custom_pb = PathBuf::from(&custom);
    if let Err(e) = fs::create_dir_all(&custom_pb) {
        tracing::error!(path = %custom_pb.display(), error = %e, "bootstrap: create custom data dir failed");
        return;
    }
    let default = commands::files::default_data_dir_raw();
    // 若 default 已经是指向 custom 的 symlink/junction，直接跳过
    if is_link_to(&default, &custom_pb) {
        return;
    }
    if default.exists() {
        // 已经是 symlink（但指向别处）→ 删除旧 symlink
        if is_symlink(&default) {
            let _ = fs::remove_dir(&default).or_else(|_| fs::remove_file(&default));
        } else {
            // 真实目录：重命名为备份，避免丢失用户历史数据
            let suf = chrono_like_timestamp_suffix();
            let parent = default.parent().unwrap_or_else(|| Path::new("."));
            let backup = parent.join(format!(
                "tsflowy-{}-bak-{}",
                default.file_name().and_then(|s| s.to_str()).unwrap_or("data"),
                suf
            ));
            if let Err(e) = fs::rename(&default, &backup) {
                tracing::error!(backup = %backup.display(), error = %e, "bootstrap: rename default data dir to backup failed");
                return;
            }
        }
    }
    // 建 junction/symlink
    if let Err(e) = ensure_dir_symlink(&default, &custom_pb) {
        tracing::error!(default = %default.display(), custom = %custom_pb.display(), error = %e, "bootstrap: ensure_dir_symlink failed");
    }
}

fn is_symlink(p: &Path) -> bool {
    match fs::symlink_metadata(p) {
        Ok(m) => m.file_type().is_symlink(),
        Err(_) => false,
    }
}

fn is_link_to(link: &Path, target: &Path) -> bool {
    if !is_symlink(link) {
        return false;
    }
    match fs::read_link(link) {
        Ok(dst) => same_path(&dst, target),
        Err(_) => false,
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
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

fn ensure_dir_symlink(link: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir parent of link: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        // Windows：优先 junction（不需要管理员/开发者模式），回退到 symlink_dir
        let link_str = link.to_string_lossy();
        let target_str = target.to_string_lossy();
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J", link_str.as_ref(), target_str.as_ref()])
            .status();
        match status {
            Ok(s) if s.success() => return Ok(()),
            _ => {}
        }
        // 回退：symlink_dir（需要开发者模式或管理员权限）
        use std::os::windows::fs::symlink_dir;
        symlink_dir(target, link).map_err(|e| format!("symlink_dir: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::symlink;
        symlink(target, link).map_err(|e| format!("symlink: {e}"))?;
        Ok(())
    }
}

fn chrono_like_timestamp_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{dur}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Phase 4 优化 · P2#5：统一 tracing 门面（默认 info，通过环境变量 TSFLOWY_LOG=debug/trace 覆盖）
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .or_else(|_| EnvFilter::try_new("info"))
                .expect("tracing env filter"),
        )
        .try_init();

    // 在 DB 打开之前，若用户配置了 custom_data_dir，
    // 把 default data dir 建为 junction/symlink 指向 custom 路径。
    bootstrap_custom_data_dir();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Rust 侧独占 DB 连接（全部持久化命令）；
            // junction 机制让 app_data_dir 透明落到 custom_data_dir。
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            if let Err(e) = fs::create_dir_all(&dir) {
                tracing::warn!(dir = %dir.display(), error = %e, "setup: create data dir failed");
            }
            let path = dir.join(db::DB_FILE);
            tracing::info!(path = %path.display(), "database file location");
            // Db::open 永不 panic：失败进 init_error，各 DB 命令返回该错误
            app.manage(db::Db::open(path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::save_asset,
            commands::files::save_asset_bytes,
            commands::files::open_asset,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::files::data_dir_path,
            commands::files::open_data_dir,
            commands::files::export_backup,
            commands::files::import_backup,
            commands::files::get_data_dir_info,
            commands::files::change_data_dir,
            commands::files::reset_data_dir_default,
            commands::db::workspace_list,
            commands::db::workspace_create,
            commands::db::workspace_rename,
            commands::db::workspace_set_icon,
            commands::db::workspace_remove,
            commands::db::view_list_by_workspace,
            commands::db::view_list_trash,
            commands::db::view_list_for_source,
            commands::db::view_list_recent,
            commands::db::view_touch_visited,
            commands::db::view_create,
            commands::db::view_get,
            commands::db::view_rename,
            commands::db::view_set_icon,
            commands::db::view_update_extra,
            commands::db::view_soft_delete,
            commands::db::view_restore,
            commands::db::view_purge,
            commands::db::view_purge_trash,
            commands::db::view_purge_expired_trash,
            commands::db::view_move,
            commands::db::setting_get,
            commands::db::setting_set,
            commands::db::doc_get,
            commands::db::doc_save,
            commands::db::doc_list_all,
            commands::db::mention_rebuild,
            commands::db::mention_list_backlinks,
            commands::db::mention_count,
            commands::db::search,
            commands::db::pp_list,
            commands::db::pp_set,
            commands::db::pp_remove,
            commands::db::pp_rename,
            commands::db::field_list,
            commands::db::field_create,
            commands::db::field_rename,
            commands::db::field_delete,
            commands::db::field_set_width,
            commands::db::field_set_hidden,
            commands::db::field_update_options,
            commands::db::field_reorder,
            commands::db::field_change_type,
            commands::db::row_list,
            commands::db::row_create,
            commands::db::row_get,
            commands::db::row_set_document_id,
            commands::db::row_delete,
            commands::db::row_reorder,
            commands::db::cells_load,
            commands::db::cell_set,
            commands::db::csv_import,
        ])
        .run(tauri::generate_context!());

    // Phase 4 优化 · P1#4：expect → 打印带上下文的 tracing 错误 + 标准退出码，避免 Rust panic 红屏
    if let Err(e) = result {
        tracing::error!(error = %e, "tsflowy exited with fatal error");
        std::process::exit(1);
    }
}