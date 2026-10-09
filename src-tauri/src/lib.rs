mod commands;
mod db;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;
use tracing_subscriber::{fmt, EnvFilter};

/// 启动前：确定数据落点并建好联接。
/// 默认落点就是 app_data_dir 本身（真实目录，Windows 上即 %APPDATA%\com.tsflowy.app）；
/// 用户设置自定义目录（config.custom_data_dir）后，把 app_data_dir 建成指向该位置的 junction/symlink，
/// 此后 app_data_dir（数据库、assets 等全部落点）透明落到自定义位置。
/// 老版本曾把默认落点设为「文档\TsFlowy」并联接过去；这里会把这类遗留联接还原为真实目录并把数据搬回。
fn bootstrap_data_dir() {
    let cfg = commands::files::load_config_raw();
    let default = commands::files::default_data_dir_raw();
    let target = match cfg.custom_data_dir.clone() {
        Some(c) => PathBuf::from(c),
        None => {
            // 未设置自定义目录：数据直接落在 app_data_dir，无需联接
            restore_real_default_dir(&default);
            return;
        }
    };
    // 悬空联接：联接条目还在，但它指向的目标目录已被外部删除/移走。
    // 若继续往下走，create_dir_all 会把目标"悄悄"建成空目录，应用随即新建一个空库，
    // 用户会以为历史数据凭空消失。这里显式记下告警并停止自愈（也不建目录），
    // 由用户在兜底页选择「导入备份」或明确「重建为空库」后再继续。
    if is_symlink(&default) && !default.exists() {
        let lost = fs::read_link(&default).unwrap_or_else(|_| target.clone());
        tracing::error!(
            link = %default.display(),
            lost = %lost.display(),
            "bootstrap: data dir link is dangling (target missing), skip auto-heal"
        );
        commands::files::set_dangling_data_dir_warning(&lost);
        return;
    }
    // 目标与默认目录同一位置，或默认目录已是指向目标的联接 → 无需处理
    if commands::files::same_path(&default, &target) || is_link_to(&default, &target) {
        return;
    }
    if let Err(e) = fs::create_dir_all(&target) {
        tracing::error!(path = %target.display(), error = %e, "bootstrap: create target data dir failed");
        return;
    }
    if default.exists() {
        if is_symlink(&default) {
            // 已是联接（但指向别处）：只删联接本身，绝不动其目标数据
            let _ = fs::remove_dir(&default).or_else(|_| fs::remove_file(&default));
        } else {
            // 真实目录：把旧数据迁移到目标，避免用户数据"消失"
            if let Err(e) = commands::files::migrate_dir_entries(&default, &target) {
                tracing::error!(from = %default.display(), to = %target.display(), error = %e, "bootstrap: migrate data failed");
                return;
            }
            // 迁移后旧目录应已空 → 删除；若仍有残留（目标已存在同名数据被跳过）则整体改名备份
            if fs::remove_dir(&default).is_err() {
                let suf = chrono_like_timestamp_suffix();
                let parent = default.parent().unwrap_or_else(|| Path::new("."));
                let backup = parent.join(format!(
                    "tsflowy-{}-bak-{}",
                    default
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("data"),
                    suf
                ));
                if let Err(e) = fs::rename(&default, &backup) {
                    tracing::error!(backup = %backup.display(), error = %e, "bootstrap: rename leftover default data dir failed");
                    return;
                }
            }
        }
    }
    if let Err(e) = ensure_dir_symlink(&default, &target) {
        tracing::error!(default = %default.display(), target = %target.display(), error = %e, "bootstrap: ensure_dir_symlink failed");
    }
}

/// 默认落点回归 app_data_dir 真实目录：若默认目录当前是指向别处（老版本「文档\TsFlowy」）的联接，
/// 把目标里的数据搬回真实目录，再删掉联接条目本身（只删联接，绝不动目标里的其它文件）。
/// 悬空联接（目标已丢失）不自动重建：保留告警交由兜底页处理，避免静默建空库掩盖数据丢失。
fn restore_real_default_dir(default: &Path) {
    if !is_symlink(default) {
        return; // 已是真实目录，无需处理
    }
    if !default.exists() {
        let lost = fs::read_link(default).unwrap_or_else(|_| default.to_path_buf());
        tracing::error!(
            link = %default.display(),
            lost = %lost.display(),
            "bootstrap: default data dir link is dangling (target missing), skip auto-heal"
        );
        commands::files::set_dangling_data_dir_warning(&lost);
        return;
    }
    let src = match fs::read_link(default) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(link = %default.display(), error = %e, "bootstrap: read data dir link failed");
            return;
        }
    };
    // 摘掉联接条目（删联接不删目标数据）→ 建真实目录 → 把数据搬回来
    if let Err(e) = fs::remove_dir(default).or_else(|_| fs::remove_file(default)) {
        tracing::error!(link = %default.display(), error = %e, "bootstrap: remove data dir link failed");
        return;
    }
    if let Err(e) = fs::create_dir_all(default) {
        tracing::error!(path = %default.display(), error = %e, "bootstrap: recreate real data dir failed");
        return;
    }
    if let Err(e) = commands::files::migrate_dir_entries(&src, default) {
        tracing::error!(from = %src.display(), to = %default.display(), error = %e, "bootstrap: migrate data back to default failed");
        return;
    }
    // 原目标目录搬空后删掉；仍有残留内容（用户自己放的文件）则保留
    let _ = fs::remove_dir(&src);
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
        Ok(dst) => commands::files::same_path(&dst, target),
        Err(_) => false,
    }
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

/// 自动备份后台调度线程：每 ~1 小时醒一次，判断距上次自动备份是否已超过用户设定的间隔，
/// 到点才真正打包（间隔最小 1 小时，逐小时轮询即可满足精度，且不会让应用常驻高占用）。
/// 磁盘 I/O 在后台线程执行，不阻塞 UI；任何失败只记日志，绝不影响应用运行。
fn spawn_auto_backup_loop(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        const TICK: std::time::Duration = std::time::Duration::from_secs(3600);
        // 启动后先等一小段：让数据库/UI 完成初始化，避免开机瞬间抢 I/O
        std::thread::sleep(std::time::Duration::from_secs(30));
        loop {
            commands::files::maybe_run_auto_backup(&app);
            std::thread::sleep(TICK);
        }
    });
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

    // 在 DB 打开之前，确定数据落点：自定义目录优先，否则默认落到系统「文档」目录下的 TsFlowy，
    // 并把默认 app_data_dir 建为指向它的 junction（老版本的旧数据自动迁移过去）。
    let result = tauri::Builder::default()
        // 单实例必须第一个注册：第二次启动时回调里把已有窗口带到前台，新进程随即退出
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // 窗口几何记忆：CloseRequested / Exit 时落盘，启动恢复大小、位置、最大化
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 先把数据落点确定好（默认即 app_data_dir，设置自定义目录时建联接），再打开数据库；
            // junction 机制让 app_data_dir 透明落到自定义目录。
            bootstrap_data_dir();
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            // 悬空联接时不得补建目录：否则会把目标建成空目录、掩盖数据已丢失（见 bootstrap_data_dir）
            if commands::files::dangling_data_dir_warning().is_none() {
                if let Err(e) = fs::create_dir_all(&dir) {
                    tracing::warn!(dir = %dir.display(), error = %e, "setup: create data dir failed");
                }
            }
            let path = dir.join(db::DB_FILE);
            tracing::info!(path = %path.display(), "database file location");
            // Db::open 永不 panic：失败进 init_error，各 DB 命令返回该错误
            app.manage(db::Db::open(path));
            spawn_auto_backup_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::save_asset,
            commands::files::save_asset_bytes,
            commands::files::open_asset,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::files::write_binary_file,
            commands::files::mkdir_all,
            commands::files::read_asset_bytes,
            commands::files::data_dir_path,
            commands::files::open_data_dir,
            commands::files::export_backup,
            commands::files::import_backup,
            commands::files::get_data_dir_info,
            commands::files::change_data_dir,
            commands::files::reset_data_dir_default,
            commands::files::get_auto_backup_config,
            commands::files::set_auto_backup_config,
            commands::files::run_auto_backup_now,
            commands::files::db_health,
            commands::files::rebuild_data_dir,
            commands::files::scan_orphan_assets,
            commands::files::purge_orphan_assets,
            commands::sync::get_sync_info,
            commands::sync::set_sync_dir,
            commands::sync::open_sync_dir,
            commands::sync::run_sync,
            commands::sync::list_sync_conflicts,
            commands::sync::open_conflicts_dir,
            commands::sync::restore_sync_conflict,
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
            commands::db::view_duplicate,
            commands::db::view_rename,
            commands::db::view_set_icon,
            commands::db::view_update_extra,
            commands::db::view_set_favorite,
            commands::db::view_set_tags,
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
            commands::db::doc_snapshot_list,
            commands::db::doc_snapshot_restore,
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
            commands::db::row_create_many,
            commands::db::row_get,
            commands::db::row_set_document_id,
            commands::db::row_delete,
            commands::db::row_delete_many,
            commands::db::row_reorder,
            commands::db::cells_load,
            commands::db::cell_set,
            commands::db::cell_set_many,
            commands::db::csv_import,
            commands::ai::ai_get_config,
            commands::ai::ai_save_config,
            commands::ai::ai_test_connection,
            commands::ai::ai_chat,
            commands::ai::ai_cancel,
        ])
        .run(tauri::generate_context!());

    // Phase 4 优化 · P1#4：expect → 打印带上下文的 tracing 错误 + 标准退出码，避免 Rust panic 红屏
    if let Err(e) = result {
        tracing::error!(error = %e, "tsflowy exited with fatal error");
        std::process::exit(1);
    }
}
