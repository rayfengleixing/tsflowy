//! `commands::files` 目录模块：原本的单个 `files.rs` 按职责拆为多个子模块，
//! 这里把各子模块的公开项**原样重导出**，使 `commands::files::<name>` 路径与拆分前完全一致
//! （`lib.rs` 的 `generate_handler![commands::files::...]` 及其它模块的引用均无需改动）。
//!
//! `commands` 本身是 crate 私有模块，这里部分重导出项在本 crate 内暂无引用者，
//! 但保留它们是为了维持拆分前的模块路径，故整体允许 `unused_imports`。
#![allow(unused_imports)]

use tauri_plugin_fs::FsExt;

pub mod asset;
pub mod auto_backup;
pub mod backup;
pub mod config;
pub mod data_dir;
pub mod health;

// —— 配置读写（config.json）——
pub use config::{
    app_config_dir_raw, config_file_path, load_config_raw, AiConfig, AppConfig, AutoBackupConfig,
    SyncConfig,
};
pub(crate) use config::{load_app_config, save_app_config};

// —— 数据目录解析 / 迁移 / 自定义目录命令 ——
pub(crate) use data_dir::{app_data_dir, open_path_in_system, timestamp_suffix};
pub use data_dir::{
    change_data_dir, clear_dangling_data_dir_warning, copy_dir_all, dangling_data_dir_warning,
    data_dir_path, default_data_dir_raw, get_data_dir_info, migrate_dir_entries, open_data_dir,
    real_data_dir, reset_data_dir_default, same_path, set_dangling_data_dir_warning,
    target_data_dir, ChangeDataDirResult, DataDirInfo,
};

// —— assets 资源读写 ——
pub(crate) use asset::ASSETS_DIR;
pub use asset::{
    mkdir_all, open_asset, read_asset_bytes, read_text_file, save_asset, save_asset_bytes,
    write_binary_file, write_text_file,
};

// —— 备份导出 / 导入 ——
pub use backup::{export_backup, import_backup};
pub(crate) use backup::{make_db_snapshot, stash_current_db};

// —— 自动备份调度 ——
pub(crate) use auto_backup::{backup_dir, backup_stamp, format_local_time, latest_auto_backup};
pub use auto_backup::{
    get_auto_backup_config, maybe_run_auto_backup, run_auto_backup, run_auto_backup_now,
    set_auto_backup_config, AutoBackupInfo,
};

// —— 数据库健康诊断（兜底提示页）——
pub use health::{db_health, rebuild_data_dir, DbHealth};

// —— 未引用资源扫描 / 回收 ——
pub mod orphan;
pub use orphan::{
    purge_orphan_assets, scan_orphan_assets, OrphanAsset, OrphanPurge, OrphanScan,
};

// —— 文件对话框路径白名单 ——
/// 只放行用户在本机文件对话框中明确选择过的路径（目录含其子树）。
///
/// Tauri 的 dialog 插件在 `open` / `save` 返回时会用 `allow_file` / `allow_directory`
/// 把所选路径写进 fs 插件的 scope，而渲染层**没有任何命令**能直接扩充这个 scope，
/// 因此复用它即得一份前端无法伪造的白名单。
///
/// 用于给 `read_text_file` / `write_text_file` / `save_asset` 这类"读写任意路径"的命令兜底：
/// 这些命令不走 fs 插件、本不受 scope 约束，加了这道校验后，即使渲染层被注入脚本，
/// 也无法凭猜测路径读写磁盘上的任意文件。
pub(crate) fn ensure_dialog_authorized(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    match app.try_fs_scope() {
        Some(scope) if scope.is_allowed(path) => Ok(()),
        Some(_) => Err(format!("path not authorized by a file dialog: {path}")),
        None => Err("file scope unavailable".to_string()),
    }
}

// —— Tauri 命令宏重导出 ——
// `#[tauri::command]` 会把每个命令函数的 `__cmd__<name>` / `__tauri_command_name_<name>` 宏
// 定义在**该函数所在模块**内并 `pub use` 出来。命令现已移入子模块，若不在此处一并重导出，
// `generate_handler![commands::files::<name>]` 展开出的 `commands::files::__cmd__<name>` 将无法解析。
#[doc(hidden)]
pub use asset::{
    __cmd__mkdir_all, __cmd__open_asset, __cmd__read_asset_bytes, __cmd__read_text_file,
    __cmd__save_asset, __cmd__save_asset_bytes, __cmd__write_binary_file, __cmd__write_text_file,
    __tauri_command_name_mkdir_all, __tauri_command_name_open_asset,
    __tauri_command_name_read_asset_bytes, __tauri_command_name_read_text_file,
    __tauri_command_name_save_asset, __tauri_command_name_save_asset_bytes,
    __tauri_command_name_write_binary_file, __tauri_command_name_write_text_file,
};
#[doc(hidden)]
pub use auto_backup::{
    __cmd__get_auto_backup_config, __cmd__run_auto_backup_now, __cmd__set_auto_backup_config,
    __tauri_command_name_get_auto_backup_config, __tauri_command_name_run_auto_backup_now,
    __tauri_command_name_set_auto_backup_config,
};
#[doc(hidden)]
pub use backup::{
    __cmd__export_backup, __cmd__import_backup, __tauri_command_name_export_backup,
    __tauri_command_name_import_backup,
};
#[doc(hidden)]
pub use data_dir::{
    __cmd__change_data_dir, __cmd__data_dir_path, __cmd__get_data_dir_info, __cmd__open_data_dir,
    __cmd__reset_data_dir_default, __tauri_command_name_change_data_dir,
    __tauri_command_name_data_dir_path, __tauri_command_name_get_data_dir_info,
    __tauri_command_name_open_data_dir, __tauri_command_name_reset_data_dir_default,
};
#[doc(hidden)]
pub use health::{
    __cmd__db_health, __cmd__rebuild_data_dir, __tauri_command_name_db_health,
    __tauri_command_name_rebuild_data_dir,
};
#[doc(hidden)]
pub use orphan::{
    __cmd__purge_orphan_assets, __cmd__scan_orphan_assets,
    __tauri_command_name_purge_orphan_assets, __tauri_command_name_scan_orphan_assets,
};
