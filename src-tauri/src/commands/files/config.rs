use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 存放 config.json 的独立子目录名（放在 config 系统目录下，避免被"重命名默认数据目录为备份"一起搬走）
const CONFIG_DIR_NAME: &str = "TsFlowyConfig";
const CONFIG_FILE_NAME: &str = "config.json";

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
    /// OpenAI 兼容接口的 base_url，例如 https://api.deepseek.com（可能已含 /v1）
    pub base_url: String,
    /// 模型名，例如 deepseek-chat
    pub model: String,
    /// API Key（本地明文存储；对前端只回传掩码）
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
}

fn default_temperature() -> f64 {
    0.7
}

fn default_confirm_edit() -> bool {
    true
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: String::new(),
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            max_chars: 8000,
            confirm_edit: true,
            temperature: default_temperature(),
            max_tokens: 0,
            system_prompt: String::new(),
            profiles: Vec::new(),
            active_profile: String::new(),
            quick_actions: Vec::new(),
            use_tools: false,
        }
    }
}

/// 一个模型档位：同一套 Key 下切换不同服务商 / 模型 / 温度
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
}

impl Default for AiProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            model: String::new(),
            temperature: default_temperature(),
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
}

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

pub fn load_config_raw() -> AppConfig {
    let p = config_file_path();
    (|| -> Option<AppConfig> {
        let s = fs::read_to_string(&p).ok()?;
        serde_json::from_str(&s).ok()
    })()
    .unwrap_or_default()
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
    (|| -> Option<AppConfig> {
        let s = fs::read_to_string(&p).ok()?;
        serde_json::from_str(&s).ok()
    })()
    .unwrap_or_default()
}

pub(crate) fn save_app_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    // 同目录临时文件 + rename 覆盖：磁盘上的 config.json 任何时刻要么是旧完整内容、要么是新完整内容，
    // 不会因写一半崩溃/断电留下半截 JSON（损坏会被 load_app_config 静默回落默认值，自定义目录等设置就“丢了”）
    let tmp = dir.join(format!("{CONFIG_FILE_NAME}.tmp"));
    fs::write(&tmp, s).map_err(|e| format!("write config: {e}"))?;
    fs::rename(&tmp, dir.join(CONFIG_FILE_NAME)).map_err(|e| format!("replace config: {e}"))
}
