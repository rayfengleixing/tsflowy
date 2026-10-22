// 配置的数据形状：AppConfig 及其各个子块（AI / 同步 / 自动备份 / 快照 / 回收站 / 唤起快捷键），
// 含各自的默认值函数与 clamp/normalize 口径（从 config.rs 原样搬入，逻辑未改）。
use super::*;

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
    /// 系统级唤起/聚焦主窗的快捷键（旧 config.json 无此字段时为 Ctrl+Alt+T）
    #[serde(default)]
    pub capture_shortcut: CaptureShortcut,
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
    /// 一次提问内允许的模型往返上限（每轮检索往返算一次）。0 或缺省时用默认值。
    #[serde(default = "default_agent_rounds")]
    pub agent_rounds: u32,
    /// 等待首个响应帧的上限（秒）：本地模型冷加载可能要几十秒，写死 30 秒会让用户以为配置坏了。
    #[serde(default = "default_first_byte_timeout")]
    pub first_byte_timeout: u32,
    /// 两帧之间的静默上限（秒）：超过即判定假死并报错，不给「永远转圈的界面」。
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout: u32,
    /// 流开始前的重试次数（建连失败 / 429 / 5xx）。0 = 明确不重试。
    #[serde(default = "default_stream_retries")]
    pub stream_retries: u32,
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

fn default_agent_rounds() -> u32 {
    AI_AGENT_ROUNDS_DEFAULT
}

fn default_first_byte_timeout() -> u32 {
    AI_FIRST_BYTE_TIMEOUT_DEFAULT
}

fn default_idle_timeout() -> u32 {
    AI_IDLE_TIMEOUT_DEFAULT
}

fn default_stream_retries() -> u32 {
    AI_STREAM_RETRIES_DEFAULT
}

/// 网络与 agent 循环默认值：前端设置页与保存时的归零回落共用同一口径
pub const AI_AGENT_ROUNDS_DEFAULT: u32 = 4;
pub const AI_FIRST_BYTE_TIMEOUT_DEFAULT: u32 = 30;
pub const AI_IDLE_TIMEOUT_DEFAULT: u32 = 120;
pub const AI_STREAM_RETRIES_DEFAULT: u32 = 2;

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
            agent_rounds: default_agent_rounds(),
            first_byte_timeout: default_first_byte_timeout(),
            idle_timeout: default_idle_timeout(),
            stream_retries: default_stream_retries(),
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

/// 系统级「唤起/聚焦主窗」快捷键。
///
/// 存 config.json 而不是 localStorage：注册要赶在前端起来之前，而 config.json 是进备份包的，
/// 换机后这条绑定跟着走。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(default)]
pub struct CaptureShortcut {
    /// false = 不注册任何系统级快捷键
    pub enabled: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    /// 前端录制器交出的规范键名（小写：`t`、`f5`、`space`、`arrowup`）
    pub key: String,
}

impl Default for CaptureShortcut {
    fn default() -> Self {
        // 与这份改动之前硬编码的那条一致：老用户升级后行为不变
        Self {
            enabled: true,
            ctrl: true,
            shift: false,
            alt: true,
            key: "t".to_string(),
        }
    }
}

impl CaptureShortcut {
    /// 拼成 global-hotkey 认得的加速串（`Control+Alt+T`）。
    /// 键名不自己维护码表，直接交给厂商的 parse_key：它的表比手写全，且随依赖更新。
    pub fn accelerator(&self) -> Result<String, String> {
        let key = self.key.trim();
        if key.is_empty() {
            return Err("快捷键缺少按键".to_string());
        }
        // 不带 Ctrl/Alt 的全局快捷键会吃掉正常输入（单独 Shift+A 之类），一律拒绝
        if !(self.ctrl || self.alt) {
            return Err("全局快捷键要带 Ctrl 或 Alt".to_string());
        }
        let mut parts: Vec<&str> = Vec::with_capacity(4);
        if self.ctrl {
            parts.push("Control");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.shift {
            parts.push("Shift");
        }
        parts.push(key);
        Ok(parts.join("+"))
    }
}
