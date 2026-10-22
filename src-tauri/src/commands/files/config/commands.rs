// 设置页读写的那几条命令：数据保留策略与界面偏好（prefs），含 RetentionPolicyInfo 与归一化口径
// （从 config.rs 原样搬入，逻辑未改）。配置结构与 load/save 见 types.rs / store.rs。
use super::*;

/// 数据保留策略（文档快照 + 回收站），设置页读写
#[derive(Debug, Serialize)]
pub struct RetentionPolicyInfo {
    pub snapshot_interval_minutes: u64,
    pub snapshot_keep: u64,
    pub snapshot_pre_restore_keep: u64,
    pub trash_retention_days: u64,
}

/// 读取数据保留策略（返回 normalized 后的有效值）
#[tauri::command]
pub fn get_retention_policy(app: tauri::AppHandle) -> RetentionPolicyInfo {
    retention_info(&load_app_config(&app))
}

/// 写入数据保留策略（前端传变更后的完整四项；越界值夹回后再落盘）
#[tauri::command]
pub fn set_retention_policy(
    app: tauri::AppHandle,
    snapshot_interval_minutes: u64,
    snapshot_keep: u64,
    snapshot_pre_restore_keep: u64,
    trash_retention_days: u64,
) -> Result<RetentionPolicyInfo, String> {
    let mut cfg = load_app_config(&app);
    cfg.snapshot = SnapshotConfig {
        interval_minutes: snapshot_interval_minutes,
        keep: snapshot_keep,
        pre_restore_keep: snapshot_pre_restore_keep,
    };
    cfg.trash = TrashConfig {
        retention_days: trash_retention_days,
    };
    save_app_config(&app, &cfg)?;
    Ok(retention_info(&cfg))
}

/// 单个镜像值的上限：正常偏好值是几十字节的 JSON，超过说明前端把大对象（会话正文之类）
/// 塞了进来，不能任由它把 config.json 撑爆
const PREF_VALUE_MAX_BYTES: usize = 64 * 1024;

/// 回收站到期兜底清理（Rust 侧，与自动备份共用小时级节拍）。
///
/// 为什么要放在后端：前端的清理定时器按「当前打开的工作区」跑，
/// 一台机器上从没点开过的工作区、以及关机几周后攒下的过期条目，都没人管。
/// 到期就该彻底删除是策略而不是交互，所以由进程自己保证，不依赖 UI 是否开过那页。
pub fn run_expired_trash_sweep(app: &tauri::AppHandle) {
    let days = load_app_config(app).trash.normalized().retention_days;
    let Some(db) = app.try_state::<crate::db::Db>() else {
        return; // 库还没 manage 起来（正常不会发生）：这一跳跳过，下一跳再来
    };
    let Ok(conn) = db.write_conn() else {
        return; // 库打开失败已另有 init_error 日志，这里不重复报
    };
    let deadline = crate::db::now_ms() - (days.min(TRASH_RETENTION_DAYS_MAX) as i64) * 86_400_000;
    if let Err(e) = crate::db::views::purge_expired_trash_all(&conn, deadline) {
        tracing::warn!(error = %e, "trash sweep: views failed");
    }
    if let Err(e) = crate::db::database::purge_expired_trash_rows(&conn, deadline) {
        tracing::warn!(error = %e, "trash sweep: database rows failed");
    }
}

/// 读取偏好镜像。前端在渲染首帧之前调用，用它回填本机缺失的 localStorage 键。
#[tauri::command]
pub fn get_prefs(app: tauri::AppHandle) -> HashMap<String, String> {
    load_app_config(&app).prefs
}

/// 写入偏好镜像快照（整体替换：前端每次算的是白名单的全量当前值，
/// 逐键合并反而会留下删不掉的陈旧键）
#[tauri::command]
pub fn set_prefs(app: tauri::AppHandle, prefs: HashMap<String, String>) -> Result<(), String> {
    let mut cfg = load_app_config(&app);
    cfg.prefs = prefs
        .into_iter()
        .filter(|(k, v)| !k.is_empty() && v.len() <= PREF_VALUE_MAX_BYTES)
        .collect();
    save_app_config(&app, &cfg)
}

fn retention_info(cfg: &AppConfig) -> RetentionPolicyInfo {
    let snapshot = cfg.snapshot.normalized();
    let trash = cfg.trash.normalized();
    RetentionPolicyInfo {
        snapshot_interval_minutes: snapshot.interval_minutes,
        snapshot_keep: snapshot.keep,
        snapshot_pre_restore_keep: snapshot.pre_restore_keep,
        trash_retention_days: trash.retention_days,
    }
}
