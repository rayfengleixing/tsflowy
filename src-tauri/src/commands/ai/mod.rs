//! AI 助手：读取/保存 AI 配置、连通性测试，以及流式对话的传输层。
//!
//! 本文件只留跨域共用的常量与类型；配置读写与「生效配置」解析在 `config.rs`，
//! 一次流式请求的生命周期（重试、超时、取消、把帧推给前端）在 `chat.rs`。
//! 各家协议的地址 / 鉴权 / 请求体 / SSE 帧形态差异都在 `ai_protocol` 里翻译，
//! 前端与 agent 循环看到的始终是同一套事件。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::time::timeout;

use super::ai_protocol;
use super::files::{self, secret, AiConfig};

mod chat;
mod config;

pub use chat::*;
pub use config::*;

/// 流式请求的「世代」计数：ai_cancel 自增后，正在跑的 ai_chat 会发现自己记录的世代已过期而中断。
static AI_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 连通性测试的整体上限：只要服务端 30 秒内没给出完整响应就判定不可用。
const TEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 重试退避时长（第 1、2 次重试各用一档，更多的重试次数复用最长那档）
const RETRY_BACKOFFS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

/// 首帧等待上限：配置给的是秒，0 或脏值回落到缺省档，不让一次误填变成「永远等不到」或「瞬间超时」。
fn first_chunk_timeout(ai: &AiConfig) -> Duration {
    Duration::from_secs(ai.first_byte_timeout.clamp(1, 600) as u64)
}

/// 帧间静默上限（秒），同样带下限/上限夹取
fn idle_chunk_timeout(ai: &AiConfig) -> Duration {
    Duration::from_secs(ai.idle_timeout.clamp(5, 1800) as u64)
}

/// 第 n 次重试的退避时长：超过档数后复用最后一档（重试越多等得越久，但不要指数爆炸）
fn backoff(attempt: u32) -> Duration {
    RETRY_BACKOFFS[(attempt as usize).min(RETRY_BACKOFFS.len() - 1)]
}

/// 未配置 AI 时的统一错误文案（前后端约定）。
/// 本地模型（Ollama / LM Studio 等）无需 API Key，因此就绪判断只要求 Base URL + 模型。
const NOT_CONFIGURED: &str = "尚未配置 AI：请在设置中填写 Base URL 与模型名";

/// 一条消息最多附几张图
const MAX_IMAGES_PER_MESSAGE: usize = 4;
/// 单张图片的字节上限：各家 API 的请求体都在 5–10MB 量级，base64 还要再涨约 1/3
const MAX_IMAGE_BYTES: usize = 6 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
    /// 助手消息携带的工具调用（agent 循环回灌历史时原样带回服务端）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AiToolCall>>,
    /// role=tool 时对应的调用 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 图片附件；只有 user 消息会用。各家协议的多模态块形态不同，见 ai_protocol
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<AiImage>,
}

/// 一条消息附带的图片。前端只填 `path`（assets/ 相对路径），会话存档因此很小；
/// `media_type` / `data` 由 Rust 在发请求前按 path 读出并内联。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AiImage {
    pub path: String,
    #[serde(default)]
    pub media_type: String,
    /// base64（不带 data: 前缀）
    #[serde(default)]
    pub data: String,
}

/// 服务端回传的一次函数调用（function calling 形态的完整参数）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    /// JSON 字符串形式的参数（原样转交前端解析）
    pub arguments: String,
}

#[derive(Deserialize)]
pub struct AiChatRequest {
    pub messages: Vec<AiMessage>,
    /// 前端下发的工具定义（OpenAI tools 数组，原样透传给服务端）。
    /// agent 多步循环由前端编排，Rust 侧只做单次流式传输。
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
}

/// 单次请求的 token 用量（来自响应尾帧的 usage；服务商不返回时整块为 null）
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct AiUsage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

impl AiUsage {
    /// 服务商可能在每一帧都带上 usage 字段但值为 null，只有真正有数字时才算拿到用量
    pub(crate) fn is_meaningful(&self) -> bool {
        self.prompt_tokens.is_some()
            || self.completion_tokens.is_some()
            || self.total_tokens.is_some()
    }

    /// 多家协议把用量拆在两帧里给（Anthropic：input 在 message_start、output 在 message_delta），
    /// 合并时新读到的数字优先，缺的那一项保留旧值。
    fn merged_with(self, newer: AiUsage) -> AiUsage {
        let merged = AiUsage {
            prompt_tokens: newer.prompt_tokens.or(self.prompt_tokens),
            completion_tokens: newer.completion_tokens.or(self.completion_tokens),
            total_tokens: newer.total_tokens.or(self.total_tokens),
        };
        // 两家都只分报 input/output 时 total 拿不到，按两项之和补
        if merged.total_tokens.is_none() {
            if let (Some(p), Some(c)) = (merged.prompt_tokens, merged.completion_tokens) {
                return AiUsage {
                    total_tokens: Some(p + c),
                    ..merged
                };
            }
        }
        merged
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    Chunk {
        delta: String,
    },
    /// 推理型模型（deepseek-flash / deepseek-reasoner 等）的思考增量。
    /// 与正式回答分开推，避免把思考内容混进可回填到文档的正文。
    Reasoning {
        delta: String,
    },
    Done {
        full: String,
        /// 服务商未返回用量时为 null（前端据此决定要不要显示）
        usage: Option<AiUsage>,
        /// 流式中累积的函数调用（未开启工具或模型未调用时为空）
        tool_calls: Vec<AiToolCall>,
    },
    Error {
        message: String,
        /// 错误归类码，前端据此给出不同引导（去改 Key / 稍后重试 / 充值 …）
        code: Option<String>,
    },
}

/// 回传前端的配置（绝不包含明文 api_key）
#[derive(Serialize)]
pub struct AiConfigPublic {
    pub enabled: bool,
    pub provider: String,
    /// 接口协议族：空串表示按 base_url 自动识别
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub max_chars: u32,
    /// AI 自主修改文档前先弹 diff 确认
    pub confirm_edit: bool,
    /// 采样温度（0–2）
    pub temperature: f64,
    /// 思考模式：auto / off
    pub thinking: String,
    /// 上下文 token 预算
    pub ctx_token_budget: u32,
    /// 上下文消息条数上限
    pub ctx_max_messages: u32,
    /// 随请求下发的上下文范围：full / page_only / off
    pub ctx_scope: String,
    /// 最大 token 数，0 表示不限制
    pub max_tokens: u32,
    /// 用户追加的自定义系统提示
    pub system_prompt: String,
    /// 可选模型档位
    pub profiles: Vec<AiProfilePublic>,
    /// 当前生效档位 id，空串表示单档配置
    pub active_profile: String,
    /// 用户自定义快捷指令
    pub quick_actions: Vec<AiQuickActionPublic>,
    /// 是否用 function calling 下发编辑指令
    pub use_tools: bool,
    /// 输入 token 单价（每 100 万 token），0 = 未填价
    pub price_input: f64,
    /// 输出 token 单价（每 100 万 token）
    pub price_output: f64,
    /// 一次提问内的模型往返上限（agent 检索轮次）
    pub agent_rounds: u32,
    /// 首帧等待上限（秒）
    pub first_byte_timeout: u32,
    /// 帧间静默上限（秒）
    pub idle_timeout: u32,
    /// 流开始前的重试次数
    pub stream_retries: u32,
    pub has_api_key: bool,
    pub api_key_masked: String,
    /// true = 凭据库不可用（或明文清不掉），Key 目前以明文存在 config.json
    pub api_key_plaintext: bool,
}

/// 档位（key 只回传掩码，绝不回传明文）
#[derive(Serialize, Clone)]
pub struct AiProfilePublic {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    /// 空串表示跟随全局协议
    pub protocol: String,
    pub has_api_key: bool,
    pub api_key_masked: String,
    /// true = 该档 Key 仍以明文存在 config.json（凭据库写入失败）
    pub api_key_plaintext: bool,
}

/// 自定义快捷指令
#[derive(Serialize, Clone)]
pub struct AiQuickActionPublic {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub scope: String,
}

/// 前端保存配置的入参：api_key 为 None 时保持原值、Some("") 清空、Some(s) 覆盖
#[derive(Deserialize)]
pub struct AiConfigInput {
    pub enabled: bool,
    pub provider: String,
    /// 接口协议族（空串=按 base_url 自动识别）
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub max_chars: u32,
    pub confirm_edit: bool,
    pub temperature: f64,
    /// 思考模式：非 "off" 的任何值都归一为 "auto"
    #[serde(default)]
    pub thinking: String,
    /// 0 = 回落默认值（保存时归一）
    #[serde(default)]
    pub ctx_token_budget: u32,
    #[serde(default)]
    pub ctx_max_messages: u32,
    /// 上下文范围：非 page_only / off 的任何值都归一为 full（与 thinking 同一套路）
    #[serde(default)]
    pub ctx_scope: String,
    pub max_tokens: u32,
    pub system_prompt: String,
    /// 档位整体覆盖（前端编辑后整份传回）
    pub profiles: Vec<AiProfileInput>,
    pub active_profile: String,
    pub quick_actions: Vec<AiQuickActionInput>,
    pub use_tools: bool,
    /// token 单价（每 100 万 token），前端未传时按 0（不做估算）
    #[serde(default)]
    pub price_input: f64,
    #[serde(default)]
    pub price_output: f64,
    /// 0 = 回落默认值（保存时归一）
    #[serde(default)]
    pub agent_rounds: u32,
    #[serde(default)]
    pub first_byte_timeout: u32,
    #[serde(default)]
    pub idle_timeout: u32,
    /// 注意：这里 0 是「明确不重试」，与其它几项「0=默认」不同——重试次数本来就允许关掉
    #[serde(default = "default_stream_retries_input")]
    pub stream_retries: u32,
    pub api_key: Option<String>,
}

fn default_stream_retries_input() -> u32 {
    files::AI_STREAM_RETRIES_DEFAULT
}

#[derive(Deserialize)]
pub struct AiProfileInput {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    /// 空串 = 跟随全局协议
    #[serde(default)]
    pub protocol: String,
    /// 档位独立 Key（None=保持该档位原值、Some("")=清空、Some(s)=覆盖；空串=继承全局）
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
pub struct AiQuickActionInput {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub scope: String,
}

// ---------- 命令 ----------

/// 上下文范围归一：只认 full / page_only / off（大小写不敏感），其余回落 full。
/// 这是「少带上下文」的开关，脏值宁可退回默认行为，也不要让请求什么上下文都不带。
fn normalize_ctx_scope(raw: &str) -> &'static str {
    match raw.to_ascii_lowercase().as_str() {
        "page_only" => "page_only",
        "off" => "off",
        _ => "full",
    }
}

/// 网络与 agent 循环参数归一：0 视为「未设置」回落默认（`stream_retries` 例外，0 = 明确不重试），
/// 其余夹到可用范围。本地模型冷启动可能要几十秒、自建网关会反复 429，这几项写死时用户只能等报错。
fn normalize_runtime_tuning(cfg: &AiConfigInput, ai: &mut AiConfig) {
    ai.agent_rounds = if cfg.agent_rounds == 0 {
        files::AI_AGENT_ROUNDS_DEFAULT
    } else {
        cfg.agent_rounds.clamp(1, 12)
    };
    ai.first_byte_timeout = if cfg.first_byte_timeout == 0 {
        files::AI_FIRST_BYTE_TIMEOUT_DEFAULT
    } else {
        cfg.first_byte_timeout.clamp(1, 600)
    };
    ai.idle_timeout = if cfg.idle_timeout == 0 {
        files::AI_IDLE_TIMEOUT_DEFAULT
    } else {
        cfg.idle_timeout.clamp(5, 1800)
    };
    ai.stream_retries = cfg.stream_retries.min(5);
}

#[cfg(test)]
mod tests;
