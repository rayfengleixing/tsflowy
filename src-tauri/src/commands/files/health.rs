use std::fs;

use serde::Serialize;

use crate::db::Db;

use super::auto_backup::{backup_dir, format_local_time, latest_auto_backup};
use super::config::load_app_config;
use super::data_dir::{
    app_data_dir, clear_dangling_data_dir_warning, dangling_data_dir_warning, real_data_dir,
    target_data_dir,
};

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
