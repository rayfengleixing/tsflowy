use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 存放 config.json 的独立子目录名（放在 config 系统目录下，避免被"重命名默认数据目录为备份"一起搬走）
const CONFIG_DIR_NAME: &str = "TsFlowyConfig";
/// 备份打包/回档按同一个文件名处理配置文件，故对外可见
pub(crate) const CONFIG_FILE_NAME: &str = "config.json";

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    /// 用户自定义数据目录（Windows/macOS/Linux 跨平台绝对路径）。
    /// 下一次启动时会把默认 app_data_dir 建为指向该路径的 junction/symlink，
    /// 使 app_data_dir（数据库、assets 等全部落点）透明访问自定义位置。
    pub custom_data_dir: Option<String>,
    /// 自动备份设置（旧 config.json 无此字段时取默认值）
    #[serde(default)]
    pub auto_backup: AutoBackupConfig,
    /// 双向同步设置与上次同步基线（旧 config.json 无此字段时取默认值）
    #[serde(default)]
    pub sync: SyncConfig,
    /// AI 助手设置（旧 config.json 无此字段时视为未配置）
    #[serde(default)]
    pub ai: Option<AiConfig>,
    /// 文档历史快照策略（旧 config.json 无此字段时取默认值）
    #[serde(default)]
    pub snapshot: SnapshotConfig,
    /// 回收站自动清空策略（旧 config.json 无此字段时取默认值）
    #[serde(default)]
    pub trash: TrashConfig,
    /// 偏好镜像：渲染进程那几个影响行为的 localStorage 键（自动同步、每日笔记、快捷键、外观）。
    /// 它们存在 WebView 自己的用户数据目录里，不在数据目录内 → 备份里没有，换机/重装后
    /// 自动同步会静静关着、快捷键与主题全丢。这里多存一份，config.json 是进备份包的。
    #[serde(default)]
    pub prefs: HashMap<String, String>,
}

/// AI 助手设置。provider / base_url / model 全部由用户填写：base_url 是否已含 /v1、
/// 模型名等各家不同，这里不内建默认值，避免猜错；设置页给出常见服务商的推荐值即可。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    /// 是否启用 AI 助手
    pub enabled: bool,
    /// 服务商标识：openai / deepseek / qwen / kimi / ollama ...
    pub provider: String,
    /// 接口协议族：空串=按 base_url 自动识别，或 openai / anthropic / gemini 显式指定。
    /// 与 provider 分开存：同一个服务商可能同时暴露兼容端点与原生端点。
    #[serde(default)]
    pub protocol: String,
    /// OpenAI 兼容接口的 base_url，例如 https://api.deepseek.com（可能已含 /v1）
    pub base_url: String,
    /// 模型名，例如 deepseek-chat
    pub model: String,
    /// API Key 明文回退位：正常 Key 存系统凭据库，这里只留空串；凭据库不可用时才写入明文。
    /// 无论哪种，对前端都只回传掩码。
    pub api_key: String,
    /// 请求上下文允许的最大字符数，默认 8000
    pub max_chars: u32,
    /// AI 自主修改文档前是否先弹 diff 让用户确认。默认 true：文档内容不应未经同意被改写；
    /// 追求顺手可在设置里关掉，靠「撤销」兜底。
    #[serde(default = "default_confirm_edit")]
    pub confirm_edit: bool,
    /// 采样温度（0–2）：写代码偏确定性用 0.2，写作可到 0.8
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    /// 思考模式：auto = 不下发任何推理参数（维持历史行为）；off = 显式关闭推理模型的思考。
    #[serde(default = "default_thinking")]
    pub thinking: String,
    /// 上下文 token 预算：历史消息回截时估算 token 的上限。0 或缺省时用默认值。
    #[serde(default = "default_ctx_token_budget")]
    pub ctx_token_budget: u32,
    /// 上下文消息条数上限：历史消息回截的最少条数目标。0 或缺省时用默认值。
    #[serde(default = "default_ctx_max_messages")]
    pub ctx_max_messages: u32,
    /// 随请求下发的上下文范围：full = 当前页全文 + @ 引用 + 检索（历史行为）；
    /// page_only = 只带当前页，禁用 @ 引用与检索；off = 不带当前文档，@ 引用与检索照常。
    #[serde(default = "default_ctx_scope")]
    pub ctx_scope: String,
    /// 单次回答的最大 token 数；0 表示不限制（用服务端默认）
    #[serde(default)]
    pub max_tokens: u32,
    /// 用户追加的自定义系统提示，拼在内置协议之后
    #[serde(default)]
    pub system_prompt: String,
    /// 可选的模型档位（快速 / 强力 / 本地…），面板顶部可切换
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    /// 当前生效的档位 id；空串表示用上面的单档配置
    #[serde(default)]
    pub active_profile: String,
    /// 用户自定义快捷指令（追加在内置动作之后）
    #[serde(default)]
    pub quick_actions: Vec<AiQuickAction>,
    /// 是否改用 function calling 下发编辑指令（结构化输出更可靠）。
    /// 默认 false：走文本协议，兼容 Ollama 这类工具调用支持不全的服务商。
    #[serde(default)]
    pub use_tools: bool,
    /// 输入 token 单价（每 100 万 token，货币单位由用户自定）。0 = 未填价，界面不做费用估算。
    /// 记在顶层而非档位上：档位间常是同价不同模型，逐档存价只会让用户重复填。
    #[serde(default)]
    pub price_input: f64,
    /// 输出 token 单价（每 100 万 token）
    #[serde(default)]
    pub price_output: f64,
}

fn default_temperature() -> f64 {
    0.7
}

fn default_thinking() -> String {
    "auto".to_string()
}

fn default_ctx_token_budget() -> u32 {
    AI_CTX_TOKEN_BUDGET_DEFAULT
}

fn default_ctx_max_messages() -> u32 {
    AI_CTX_MAX_MESSAGES_DEFAULT
}

/// 上下文预算默认值：前端 store 与保存时归零回落共用同一口径
pub const AI_CTX_TOKEN_BUDGET_DEFAULT: u32 = 3000;
pub const AI_CTX_MAX_MESSAGES_DEFAULT: u32 = 40;

fn default_confirm_edit() -> bool {
    true
}

fn default_ctx_scope() -> String {
    "full".to_string()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: String::new(),
            protocol: String::new(),
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            max_chars: 8000,
            confirm_edit: true,
            temperature: default_temperature(),
            thinking: default_thinking(),
            ctx_token_budget: default_ctx_token_budget(),
            ctx_max_messages: default_ctx_max_messages(),
            ctx_scope: default_ctx_scope(),
            max_tokens: 0,
            system_prompt: String::new(),
            profiles: Vec::new(),
            active_profile: String::new(),
            quick_actions: Vec::new(),
            use_tools: false,
            price_input: 0.0,
            price_output: 0.0,
        }
    }
}

/// 一个模型档位：可各自指定服务商 / 模型 / 协议 / Key / 温度。
/// protocol 为空表示继承全局设置；api_key 字段只是凭据库不可用时的明文回退，
/// 正常情况下 Key 存在系统凭据库（账户名 `ai-api-key:profile:<id>`），这里留空串。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    pub protocol: String,
    pub api_key: String,
}

impl Default for AiProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            model: String::new(),
            temperature: default_temperature(),
            protocol: String::new(),
            api_key: String::new(),
        }
    }
}

/// 用户自定义快捷指令。scope 决定取哪段文本填进 prompt：
/// selection 选中文本 / page 整页文本 / none 不取（如「续写」）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiQuickAction {
    pub id: String,
    pub name: String,
    /// 提示词模板，含 {content} 占位符（scope 为 none 时不需要）
    pub prompt: String,
    pub scope: String,
}

impl Default for AiQuickAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            prompt: String::new(),
            scope: "selection".to_string(),
        }
    }
}

/// 双向同步（#13）：把数据目录里的库 + assets 与一个「同步文件夹」对齐。
/// 同步文件夹由用户指定（OneDrive/坚果云等网盘客户端的本地文件夹、或映射到 WebDAV 的盘符），
/// 实际数据放在其下的 TsFlowySync/ 子目录，避免与用户其它文件混在一起。
///
/// 这里只保存「本机视角」的状态：上次同步时两侧库的指纹。它是判断
/// "谁改过" 的基线——没有基线的第一次同步按修改时间取新者，旧的留冲突副本。
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct SyncConfig {
    /// 用户选择的同步文件夹（空/None = 未开启同步）
    #[serde(default)]
    pub dir: Option<String>,
    /// 上次同步完成时库的 sha256（两侧已一致，同一个值）
    #[serde(default)]
    pub last_hash: Option<String>,
    /// 上次同步做了什么：none / upload / download / conflict
    #[serde(default)]
    pub last_action: Option<String>,
    /// 上次同步时间（本地时间串）
    #[serde(default)]
    pub last_time: Option<String>,
    /// 最近若干轮同步的历史，新的在前（见 sync.rs 的 push_history）
    #[serde(default)]
    pub history: Vec<SyncHistoryEntry>,
}

/// 一轮同步的留档：设置页据此回答「上次到底同步了什么、有没有失败」，
/// 而不是只剩一个 last_action 字符串。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncHistoryEntry {
    /// 本轮结束时间（本地时间串）
    pub time: String,
    /// none / upload / download / conflict / failed
    pub action: String,
    /// 本轮耗时（毫秒）：大库同步慢到几分钟时，这里是唯一能看出来的地方
    pub duration_ms: u64,
    pub assets_copied: usize,
    pub assets_deleted: usize,
    /// 本轮新产生的冲突副本文件名（位于同步目录 conflicts/ 下）
    pub conflicts: Vec<String>,
    /// action=failed 时的错误信息
    pub error: Option<String>,
}

/// 历史只留最近这么多轮：config.json 会进备份包，不能无限涨
pub const SYNC_HISTORY_MAX: usize = 50;

/// 自动备份设置。默认开启：每 24 小时打包一次 data.db 快照 + assets/ 到数据目录下的 backups/。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AutoBackupConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 两次自动备份的最小间隔（小时），下限 1
    #[serde(default = "default_interval_hours")]
    pub interval_hours: u64,
    /// backups/ 目录中保留的自动备份份数，多余按时间倒序删除
    #[serde(default = "default_keep")]
    pub keep: usize,
}

fn default_true() -> bool {
    true
}

fn default_interval_hours() -> u64 {
    24
}

fn default_keep() -> usize {
    7
}

impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            keep: 7,
        }
    }
}

impl AutoBackupConfig {
    /// 后台线程只读该配置判断是否到点，字段可能被前端写入任意值，这里统一夹到安全范围
    pub(crate) fn normalized(&self) -> Self {
        Self {
            enabled: self.enabled,
            interval_hours: self.interval_hours.clamp(1, 24 * 30),
            keep: self.keep.clamp(1, 100),
        }
    }
}

/// 文档历史快照策略。默认值与早期写死在 db::snapshots 里的常量一致。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnapshotConfig {
    /// 同一页面两次快照的最小间隔（分钟）
    #[serde(default = "default_snapshot_interval_minutes")]
    pub interval_minutes: u64,
    /// 每页保留的自动快照份数
    #[serde(default = "default_snapshot_keep")]
    pub keep: u64,
    /// 每页保留的 pre_restore 备份份数
    #[serde(default = "default_pre_restore_keep")]
    pub pre_restore_keep: u64,
}

fn default_snapshot_interval_minutes() -> u64 {
    crate::db::snapshots::SNAPSHOT_INTERVAL_MINUTES_DEFAULT
}

fn default_snapshot_keep() -> u64 {
    crate::db::snapshots::SNAPSHOT_KEEP_DEFAULT
}

fn default_pre_restore_keep() -> u64 {
    crate::db::snapshots::PRE_RESTORE_KEEP_DEFAULT
}

impl Default for SnapshotConfig {
    fn default() -> Self {
        Self {
            interval_minutes: default_snapshot_interval_minutes(),
            keep: default_snapshot_keep(),
            pre_restore_keep: default_pre_restore_keep(),
        }
    }
}

/// 前端输入框与 normalized() 共用的取值边界
pub const SNAPSHOT_INTERVAL_MINUTES_MIN: u64 = 1;
pub const SNAPSHOT_INTERVAL_MINUTES_MAX: u64 = 1440;
pub const SNAPSHOT_KEEP_MIN: u64 = 1;
pub const SNAPSHOT_KEEP_MAX: u64 = 500;
pub const PRE_RESTORE_KEEP_MIN: u64 = 1;
pub const PRE_RESTORE_KEEP_MAX: u64 = 50;

impl SnapshotConfig {
    /// 字段可能被前端写入任意值（甚至手改 config.json），统一夹到安全范围
    pub(crate) fn normalized(&self) -> Self {
        Self {
            interval_minutes: self
                .interval_minutes
                .clamp(SNAPSHOT_INTERVAL_MINUTES_MIN, SNAPSHOT_INTERVAL_MINUTES_MAX),
            keep: self.keep.clamp(SNAPSHOT_KEEP_MIN, SNAPSHOT_KEEP_MAX),
            pre_restore_keep: self
                .pre_restore_keep
                .clamp(PRE_RESTORE_KEEP_MIN, PRE_RESTORE_KEEP_MAX),
        }
    }

    /// 转成 db::snapshots 实际使用的策略参数（已 normalized，值域安全）
    pub(crate) fn policy(&self) -> crate::db::snapshots::SnapshotPolicy {
        let cfg = self.normalized();
        crate::db::snapshots::SnapshotPolicy {
            interval_ms: cfg.interval_minutes as i64 * 60_000,
            keep: cfg.keep as i64,
            pre_restore_keep: cfg.pre_restore_keep as i64,
        }
    }
}

/// 回收站自动清空策略
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrashConfig {
    /// 删除超过该天数的回收站条目由后台自动清空
    #[serde(default = "default_trash_retention_days")]
    pub retention_days: u64,
}

/// 默认保留 30 天（与前端取不到配置时的兜底值同口径）
pub const TRASH_RETENTION_DAYS_DEFAULT: u64 = 30;
pub const TRASH_RETENTION_DAYS_MIN: u64 = 1;
pub const TRASH_RETENTION_DAYS_MAX: u64 = 365;

fn default_trash_retention_days() -> u64 {
    TRASH_RETENTION_DAYS_DEFAULT
}

impl Default for TrashConfig {
    fn default() -> Self {
        Self {
            retention_days: default_trash_retention_days(),
        }
    }
}

impl TrashConfig {
    pub(crate) fn normalized(&self) -> Self {
        Self {
            retention_days: self
                .retention_days
                .clamp(TRASH_RETENTION_DAYS_MIN, TRASH_RETENTION_DAYS_MAX),
        }
    }
}

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

pub fn config_file_path() -> PathBuf {
    app_config_dir_raw().join(CONFIG_FILE_NAME)
}

/// 读取并解析 config.json。文件存在但内容损坏时**不能**静默回落默认值——
/// 那会让用户以为自定义数据目录等设置"自己丢了"。先把坏文件挪成 config.json.broken-<毫秒>
/// （保留原件供人工找回，且避免下次启动重复告警），记 warn 后再落默认值。
fn parse_config_or_rescue(p: &std::path::Path) -> AppConfig {
    let Ok(s) = fs::read_to_string(p) else {
        return AppConfig::default();
    };
    match serde_json::from_str::<AppConfig>(&s) {
        Ok(cfg) => cfg,
        Err(e) => {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let bak = p.with_file_name(format!("{CONFIG_FILE_NAME}.broken-{ms}"));
            let moved = fs::rename(p, &bak).is_ok();
            tracing::warn!(
                "config.json 损坏（{e}），{}原文件已挪到 {} 供恢复",
                if moved { "" } else { "备份失败，" },
                bak.display()
            );
            AppConfig::default()
        }
    }
}

pub fn load_config_raw() -> AppConfig {
    parse_config_or_rescue(&config_file_path())
}

fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join(CONFIG_DIR_NAME))
        .or_else(|_| Ok(app_config_dir_raw()))
}

pub(crate) fn load_app_config(app: &tauri::AppHandle) -> AppConfig {
    let p = app_config_dir(app)
        .map(|d| d.join(CONFIG_FILE_NAME))
        .unwrap_or_else(|_| config_file_path());
    parse_config_or_rescue(&p)
}

pub(crate) fn save_app_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    // 同目录临时文件 + rename 覆盖：磁盘上的 config.json 任何时刻要么是旧完整内容、要么是新完整内容，
    // 不会因写一半崩溃/断电留下半截 JSON（损坏会被 load_app_config 挪成 .broken 文件并告警，而不是静默吞掉）
    let tmp = dir.join(format!("{CONFIG_FILE_NAME}.tmp"));
    fs::write(&tmp, s).map_err(|e| format!("write config: {e}"))?;
    fs::rename(&tmp, dir.join(CONFIG_FILE_NAME)).map_err(|e| format!("replace config: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_defaults_match_the_old_hardcoded_values() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.snapshot.interval_minutes, 10);
        assert_eq!(cfg.snapshot.keep, 50);
        assert_eq!(cfg.snapshot.pre_restore_keep, 5);
        assert_eq!(cfg.trash.retention_days, 30);
    }

    /// 旧 config.json 没有 snapshot / trash 字段：整体按默认值回落，其余字段不受影响
    #[test]
    fn config_without_retention_fields_falls_back_to_defaults() {
        let legacy = r#"{
            "custom_data_dir": "D:/data",
            "auto_backup": { "enabled": false, "interval_hours": 6, "keep": 3 },
            "sync": { "dir": null }
        }"#;
        let cfg: AppConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(cfg.custom_data_dir.as_deref(), Some("D:/data"));
        assert_eq!(
            (
                cfg.auto_backup.enabled,
                cfg.auto_backup.interval_hours,
                cfg.auto_backup.keep
            ),
            (false, 6, 3)
        );
        assert_eq!(cfg.snapshot.interval_minutes, 10);
        assert_eq!(cfg.snapshot.keep, 50);
        assert_eq!(cfg.snapshot.pre_restore_keep, 5);
        assert_eq!(cfg.trash.retention_days, 30);
    }

    /// 字段残缺（如只写了 keep）时，缺的那几项同样走默认值而不是 0
    #[test]
    fn partially_present_retention_fields_use_defaults() {
        let cfg: AppConfig =
            serde_json::from_str(r#"{"snapshot":{"keep":120},"trash":{}}"#).unwrap();
        assert_eq!(cfg.snapshot.keep, 120);
        assert_eq!(cfg.snapshot.interval_minutes, 10);
        assert_eq!(cfg.snapshot.pre_restore_keep, 5);
        assert_eq!(cfg.trash.retention_days, 30);
    }

    #[test]
    fn snapshot_config_clamps_to_safe_range() {
        let low = SnapshotConfig {
            interval_minutes: 0,
            keep: 0,
            pre_restore_keep: 0,
        }
        .normalized();
        assert_eq!(
            (low.interval_minutes, low.keep, low.pre_restore_keep),
            (
                SNAPSHOT_INTERVAL_MINUTES_MIN,
                SNAPSHOT_KEEP_MIN,
                PRE_RESTORE_KEEP_MIN
            )
        );

        let high = SnapshotConfig {
            interval_minutes: 999_999,
            keep: 999_999,
            pre_restore_keep: 999_999,
        }
        .normalized();
        assert_eq!(
            (high.interval_minutes, high.keep, high.pre_restore_keep),
            (
                SNAPSHOT_INTERVAL_MINUTES_MAX,
                SNAPSHOT_KEEP_MAX,
                PRE_RESTORE_KEEP_MAX
            )
        );
    }

    /// 偏好镜像是后加的字段：旧 config.json 没有它时必须读成空表而不是报错
    #[test]
    fn legacy_config_without_prefs_reads_as_empty_map() {
        let cfg: AppConfig = serde_json::from_str(r#"{"custom_data_dir":"D:/data"}"#).unwrap();
        assert!(cfg.prefs.is_empty());
        let round: AppConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert!(round.prefs.is_empty());
    }

    #[test]
    fn prefs_round_trip_keeps_every_key() {
        let mut cfg = AppConfig::default();
        cfg.prefs.insert(
            "tsflowy:auto-sync".to_string(),
            "{\"periodic\":true}".to_string(),
        );
        let parsed: AppConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(
            parsed.prefs.get("tsflowy:auto-sync").map(String::as_str),
            Some("{\"periodic\":true}")
        );
    }

    #[test]
    fn trash_config_clamps_to_safe_range() {
        assert_eq!(
            TrashConfig { retention_days: 0 }
                .normalized()
                .retention_days,
            TRASH_RETENTION_DAYS_MIN
        );
        assert_eq!(
            TrashConfig {
                retention_days: 400
            }
            .normalized()
            .retention_days,
            TRASH_RETENTION_DAYS_MAX
        );
        assert_eq!(
            TrashConfig { retention_days: 7 }
                .normalized()
                .retention_days,
            7
        );
    }

    /// 配置以分钟为单位，注入 db::snapshots 时换算成毫秒
    #[test]
    fn snapshot_policy_converts_minutes_and_clamps_first() {
        let policy = SnapshotConfig {
            interval_minutes: 30,
            keep: 20,
            pre_restore_keep: 2,
        }
        .policy();
        assert_eq!(policy.interval_ms, 30 * 60 * 1000);
        assert_eq!(policy.keep, 20);
        assert_eq!(policy.pre_restore_keep, 2);

        let clamped = SnapshotConfig {
            interval_minutes: 0,
            keep: 5_000,
            pre_restore_keep: 5_000,
        }
        .policy();
        assert_eq!(
            clamped.interval_ms,
            SNAPSHOT_INTERVAL_MINUTES_MIN as i64 * 60_000
        );
        assert_eq!(clamped.keep, SNAPSHOT_KEEP_MAX as i64);
        assert_eq!(clamped.pre_restore_keep, PRE_RESTORE_KEEP_MAX as i64);
    }
}
