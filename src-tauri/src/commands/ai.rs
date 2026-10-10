//! AI 助手：读取/保存 AI 配置、连通性测试，以及走 OpenAI 兼容协议的流式对话。
//!
//! openai / deepseek / qwen / kimi / ollama 等都暴露同一套接口：
//! `POST {base_url}/chat/completions`，鉴权 `Authorization: Bearer <key>`，响应为 SSE。
//! base_url 由用户填写（可能已含 /v1），这里只去掉结尾 `/` 后原样拼 `/chat/completions`。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::time::timeout;

use super::files::{self, secret, AiConfig};

/// 流式请求的「世代」计数：ai_cancel 自增后，正在跑的 ai_chat 会发现自己记录的世代已过期而中断。
static AI_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 等待首个响应帧的上限：连上之后服务商迟迟不吐第一个字节（队列排队、鉴权卡住等）时及时报错。
const FIRST_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
/// 两帧之间的静默上限。推理型模型会先长时间输出 reasoning，期间帧不断，因此给得较宽。
const IDLE_CHUNK_TIMEOUT: Duration = Duration::from_secs(120);
/// 连通性测试的整体上限：只要服务端 30 秒内没给出完整响应就判定不可用。
const TEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 流开始前的重试次数：建连失败与 429 / 5xx 各最多再试 2 次。
const PRE_STREAM_RETRIES: u32 = 2;
/// 重试退避时长（第 1、2 次重试各用一档）
const RETRY_BACKOFFS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];
/// 文本协议里编辑指令块的标记（与前端 lib/ai-edit.ts 的 EDIT_BLOCK_TAG 保持一致）。
/// 开启工具调用时，会把函数参数原样包成这个块，好让前端的解析逻辑完全复用。
const EDIT_BLOCK_TAG: &str = "tsflowy-edit";

/// 未配置 AI 时的统一错误文案（前后端约定）
const NOT_CONFIGURED: &str = "尚未配置 AI：请在设置中填写服务商与 API Key";

#[derive(Serialize, Deserialize, Clone)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct AiChatRequest {
    pub messages: Vec<AiMessage>,
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
    fn is_meaningful(&self) -> bool {
        self.prompt_tokens.is_some() || self.completion_tokens.is_some() || self.total_tokens.is_some()
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
    pub base_url: String,
    pub model: String,
    pub max_chars: u32,
    /// AI 自主修改文档前先弹 diff 确认
    pub confirm_edit: bool,
    /// 采样温度（0–2）
    pub temperature: f64,
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
    pub has_api_key: bool,
    pub api_key_masked: String,
}

/// 档位（不含任何敏感字段，直接回传前端）
#[derive(Serialize, Clone)]
pub struct AiProfilePublic {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
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
    pub base_url: String,
    pub model: String,
    pub max_chars: u32,
    pub confirm_edit: bool,
    pub temperature: f64,
    pub max_tokens: u32,
    pub system_prompt: String,
    /// 档位整体覆盖（前端编辑后整份传回）
    pub profiles: Vec<AiProfileInput>,
    pub active_profile: String,
    pub quick_actions: Vec<AiQuickActionInput>,
    pub use_tools: bool,
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
pub struct AiProfileInput {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
}

#[derive(Deserialize)]
pub struct AiQuickActionInput {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub scope: String,
}

// ---------- 命令 ----------

/// 读取 AI 配置（掩码返回，不泄露 key）
#[tauri::command]
pub fn ai_get_config(app: tauri::AppHandle) -> Result<AiConfigPublic, String> {
    let cfg = files::load_app_config(&app);
    let key = effective_api_key(&app);
    Ok(public_of(&cfg, &key))
}

/// 保存 AI 配置
#[tauri::command]
pub fn ai_save_config(app: tauri::AppHandle, cfg: AiConfigInput) -> Result<(), String> {
    let mut app_cfg = files::load_app_config(&app);
    let mut ai = app_cfg.ai.take().unwrap_or_default();
    ai.enabled = cfg.enabled;
    ai.provider = cfg.provider;
    ai.base_url = cfg.base_url;
    ai.model = cfg.model;
    ai.max_chars = cfg.max_chars;
    ai.confirm_edit = cfg.confirm_edit;
    ai.temperature = cfg.temperature.clamp(0.0, 2.0);
    ai.max_tokens = cfg.max_tokens;
    ai.system_prompt = cfg.system_prompt;
    ai.profiles = cfg
        .profiles
        .into_iter()
        .map(|p| files::AiProfile {
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            model: p.model,
            temperature: p.temperature.clamp(0.0, 2.0),
        })
        .collect();
    ai.active_profile = cfg.active_profile;
    ai.quick_actions = cfg
        .quick_actions
        .into_iter()
        .map(|a| files::AiQuickAction {
            id: a.id,
            name: a.name,
            prompt: a.prompt,
            // 只认三种取值，其它一律回落 selection
            scope: match a.scope.as_str() {
                "page" => "page".to_string(),
                "none" => "none".to_string(),
                _ => "selection".to_string(),
            },
        })
        .collect();
    ai.use_tools = cfg.use_tools;
    // None 保持原值不变；Some("") 清空；Some(s) 覆盖。
    // 非空 key 优先写入系统凭据库：成功则 config.json 不留明文；失败则回退明文，保证可用。
    match cfg.api_key {
        None => {}
        Some(key) if key.trim().is_empty() => {
            secret::delete_key();
            ai.api_key = String::new();
        }
        Some(key) => {
            if secret::store_key(&key) {
                ai.api_key = String::new();
            } else {
                ai.api_key = key;
            }
        }
    }
    app_cfg.ai = Some(ai);
    files::save_app_config(&app, &app_cfg)
}

/// 用当前配置发一条极短的非流式请求，成功返回模型回复文本
#[tauri::command]
pub async fn ai_test_connection(app: tauri::AppHandle) -> Result<String, String> {
    let ai = effective_ai(&app)?;
    let client = build_client()?;
    let body = serde_json::json!({
        "model": ai.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 8,
        "stream": false,
    });
    // connect_timeout 只管建连，服务端接受连接后迟迟不响应（队列排队、鉴权卡住）仍会永久挂住，
    // 因此再套一层整体超时：30 秒内拿不到响应就判定不可用。
    let pending = client
        .post(chat_url(&ai.base_url))
        .bearer_auth(&ai.api_key)
        .json(&body)
        .send();
    let resp = match timeout(TEST_TIMEOUT, pending).await {
        Ok(r) => r.map_err(|e| format!("连接失败：{e}"))?,
        Err(_) => return Err("连接超时（30 秒），请检查网络或 Base URL 是否正确".to_string()),
    };
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(readable_http_error(status.as_u16(), &text));
    }
    parse_completion_text(&text)
}

/// 拉取当前 base_url 下的可用模型列表（GET /models），供设置页下拉选择。
/// 服务商不提供该接口时会报错，设置页提示改为手工填写即可。
#[tauri::command]
pub async fn ai_list_models(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let ai = effective_ai(&app)?;
    let client = build_client()?;
    let resp = timeout(
        TEST_TIMEOUT,
        client.get(models_url(&ai.base_url)).bearer_auth(&ai.api_key).send(),
    )
    .await
    .map_err(|_| "拉取模型列表超时（30 秒）".to_string())?
    .map_err(|e| format!("连接失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(readable_http_error(status.as_u16(), &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("响应解析失败：{e}"))?;
    let mut out: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    if out.is_empty() {
        return Err("服务端没有返回可用模型".to_string());
    }
    Ok(out)
}

/// 中断当前正在进行的流式请求
#[tauri::command]
pub fn ai_cancel() -> Result<(), String> {
    AI_GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// 流式对话：逐块通过 channel 推给前端。
/// 配置错误直接返回 Err；一旦进入流式阶段，任何失败都以 AiEvent::Error 通知前端。
#[tauri::command]
pub async fn ai_chat(
    app: tauri::AppHandle,
    req: AiChatRequest,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    let ai = effective_ai(&app)?;
    let generation = AI_GENERATION.load(Ordering::SeqCst);
    let client = build_client()?;
    // 自定义系统提示放在消息序列最后：离用户问题越近，模型越容易遵守
    let mut messages = req.messages;
    let custom = ai.system_prompt.trim();
    if !custom.is_empty() {
        messages.push(AiMessage {
            role: "system".to_string(),
            content: custom.to_string(),
        });
    }
    let mut body = serde_json::json!({
        "model": ai.model,
        "messages": messages,
        "stream": true,
        // 让支持的服务商在尾帧回传 token 用量；不支持的会忽略这个字段
        "stream_options": { "include_usage": true },
    });
    // 温度夹到合法区间，避免用户填出界让服务端直接 400；max_tokens 为 0 时不下发（用服务端默认）
    if let Some(obj) = body.as_object_mut() {
        obj.insert("temperature".into(), serde_json::json!(ai.temperature.clamp(0.0, 2.0)));
        if ai.max_tokens > 0 {
            obj.insert("max_tokens".into(), serde_json::json!(ai.max_tokens));
        }
        // 开启后改用 function calling 让模型下发编辑指令：结构化输出比自由文本更不容易写坏
        if ai.use_tools {
            obj.insert(
                "tools".into(),
                serde_json::json!([{
                    "type": "function",
                    "function": {
                        "name": "apply_edit",
                        "description": "把改动写进用户当前打开的文档。需要改动文档时调用；只是回答问题时不要调用。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "op": {
                                    "type": "string",
                                    "enum": ["replace_selection", "insert_at_cursor", "append_to_document"],
                                    "description": "replace_selection 替换选中文字（无选中时退化成光标处插入）；insert_at_cursor 光标处插入；append_to_document 追加到文档末尾"
                                },
                                "summary": { "type": "string", "description": "一句话中文说明改了什么" },
                                "content": { "type": "string", "description": "改动后的 Markdown 内容" }
                            },
                            "required": ["op", "summary", "content"]
                        }
                    }
                }]),
            );
            obj.insert("tool_choice".into(), serde_json::json!("auto"));
        }
    }
    // 流开始前允许重试：建连失败 / 429 / 5xx 各退避再试，最多 PRE_STREAM_RETRIES 次。
    // 进入流式阶段后绝不重试——内容可能已经吐给前端，重试会造成重复输出。
    let resp = {
        let mut attempt: u32 = 0;
        loop {
            if cancelled(generation) {
                let _ = on_event.send(AiEvent::Error {
                    message: "cancelled".to_string(),
                    code: Some("cancelled".to_string()),
                });
                return Ok(());
            }
            let sent = client
                .post(chat_url(&ai.base_url))
                .bearer_auth(&ai.api_key)
                .json(&body)
                .send()
                .await;
            match sent {
                Err(e) => {
                    if attempt < PRE_STREAM_RETRIES && !cancelled(generation) {
                        tokio::time::sleep(RETRY_BACKOFFS[attempt as usize]).await;
                        attempt += 1;
                        continue;
                    }
                    let _ = on_event.send(AiEvent::Error {
                        message: format!("连接失败：{e}"),
                        code: Some("network".to_string()),
                    });
                    return Ok(());
                }
                Ok(r) => {
                    let status = r.status();
                    if status.is_success() {
                        break r;
                    }
                    // 429 优先尊重服务端的 Retry-After，其余按固定退避；读正文前取头
                    let wait = if retryable_status(status) {
                        retry_after(&r, RETRY_BACKOFFS[attempt.min(1) as usize])
                    } else {
                        Duration::ZERO
                    };
                    if attempt < PRE_STREAM_RETRIES && retryable_status(status) && !cancelled(generation) {
                        tokio::time::sleep(wait).await;
                        attempt += 1;
                        continue;
                    }
                    let text = r.text().await.unwrap_or_default();
                    let code = error_code(status.as_u16(), &text);
                    let _ = on_event.send(AiEvent::Error {
                        message: readable_http_error(status.as_u16(), &text),
                        code: Some(code.to_string()),
                    });
                    return Ok(());
                }
            }
        }
    };

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    // SSE 事件可能跨多个字节块到达：按行切分，未成行的残留留到下一轮。
    // 累积字节而非字符串，避免多字节 UTF-8（中文）被拆到两个块时解码成乱码。
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    // 工具调用的函数参数增量（开启 use_tools 时才有），最后整体拼成指令块
    let mut tool_args = String::new();
    let mut usage: Option<AiUsage> = None;
    // 首帧用较短的等待上限，之后放宽：推理型模型会先长时间吐 reasoning，期间帧是连续的。
    let mut awaiting_first = true;

    loop {
        let wait = if awaiting_first {
            FIRST_CHUNK_TIMEOUT
        } else {
            IDLE_CHUNK_TIMEOUT
        };
        // 没有总超时（长回答可能持续数分钟），但任何一段「静默」都必须在上限内出新帧，
        // 否则视为网络假死，主动报错而不是让用户面对一个永远转圈的界面。
        let item = match timeout(wait, stream.next()).await {
            Ok(Some(item)) => item,
            Ok(None) => break,
            Err(_) => {
                let message = if awaiting_first {
                    "等待模型首个响应超时（30 秒），请检查网络或服务商状态后重试"
                } else {
                    "模型响应中断超过 120 秒，已停止等待"
                };
                let _ = on_event.send(AiEvent::Error {
                    message: message.to_string(),
                    code: Some("timeout".to_string()),
                });
                return Ok(());
            }
        };
        if cancelled(generation) {
            let _ = on_event.send(AiEvent::Error {
                message: "cancelled".to_string(),
                code: Some("cancelled".to_string()),
            });
            return Ok(());
        }
        match item {
            Ok(bytes) => {
                awaiting_first = false;
                buf.extend_from_slice(&bytes);
            }
            Err(e) => {
                let _ = on_event.send(AiEvent::Error {
                    message: format!("读取流失败：{e}"),
                    code: Some("network".to_string()),
                });
                return Ok(());
            }
        }
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            // 去掉行尾的 '\n'
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            match parse_sse_line(&line) {
                SseParse::Delta(delta) => {
                    if cancelled(generation) {
                        let _ = on_event.send(AiEvent::Error {
                            message: "cancelled".to_string(),
                            code: Some("cancelled".to_string()),
                        });
                        return Ok(());
                    }
                    full.push_str(&delta);
                    if on_event.send(AiEvent::Chunk { delta }).is_err() {
                        return Ok(());
                    }
                }
                SseParse::Reasoning(delta) => {
                    if cancelled(generation) {
                        let _ = on_event.send(AiEvent::Error {
                            message: "cancelled".to_string(),
                            code: Some("cancelled".to_string()),
                        });
                        return Ok(());
                    }
                    // 思考内容不计入 full：Done 回传的仍只是正式回答
                    if on_event.send(AiEvent::Reasoning { delta }).is_err() {
                        return Ok(());
                    }
                }
                SseParse::Error(message) => {
                    // 流里报的错拿不到状态码，按关键字猜一个归类
                    let code = guess_error_code(&message);
                    let _ = on_event.send(AiEvent::Error {
                        message,
                        code: Some(code.to_string()),
                    });
                    return Ok(());
                }
                SseParse::Usage(u) => {
                    usage = Some(u);
                }
                SseParse::ToolArgs(args) => {
                    tool_args.push_str(&args);
                }
                SseParse::Done => {
                    append_tool_block(&mut full, &tool_args);
                    let _ = on_event.send(AiEvent::Done { full, usage });
                    return Ok(());
                }
                SseParse::Ignore => {}
            }
        }
    }
    // 服务端未发 [DONE] 就断流：按正常结束处理，把已收到的内容交给前端
    append_tool_block(&mut full, &tool_args);
    let _ = on_event.send(AiEvent::Done { full, usage });
    Ok(())
}

// ---------- 纯函数（便于离线单测） ----------

fn cancelled(generation: u64) -> bool {
    AI_GENERATION.load(Ordering::SeqCst) != generation
}

/// 从 AppConfig 构造回传前端的掩码视图；key 相关字段基于「生效 key」计算
/// （生效 key = 系统凭据库优先，回退 config.json 明文）。
fn public_of(cfg: &files::AppConfig, effective_key: &str) -> AiConfigPublic {
    let ai = cfg.ai.clone().unwrap_or_default();
    AiConfigPublic {
        enabled: ai.enabled,
        provider: ai.provider,
        base_url: ai.base_url,
        model: ai.model,
        max_chars: ai.max_chars,
        confirm_edit: ai.confirm_edit,
        temperature: ai.temperature,
        max_tokens: ai.max_tokens,
        system_prompt: ai.system_prompt.clone(),
        profiles: ai
            .profiles
            .iter()
            .map(|p| AiProfilePublic {
                id: p.id.clone(),
                name: p.name.clone(),
                base_url: p.base_url.clone(),
                model: p.model.clone(),
                temperature: p.temperature,
            })
            .collect(),
        active_profile: ai.active_profile.clone(),
        quick_actions: ai
            .quick_actions
            .iter()
            .map(|a| AiQuickActionPublic {
                id: a.id.clone(),
                name: a.name.clone(),
                prompt: a.prompt.clone(),
                scope: a.scope.clone(),
            })
            .collect(),
        use_tools: ai.use_tools,
        has_api_key: !effective_key.is_empty(),
        api_key_masked: mask_api_key(effective_key),
    }
}

/// API Key 掩码：长度 <= 8 返回同长度的 `*`；否则前 3 位 + `****` + 后 4 位。
fn mask_api_key(key: &str) -> String {
    let n = key.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 8 {
        return "*".repeat(n);
    }
    let head: String = key.chars().take(3).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}****{tail}")
}

/// 拼请求地址：去掉 base_url 结尾的 `/`，直接拼 `/chat/completions`（不再补 `/v1`）
fn chat_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// 拼模型列表地址：`GET {base_url}/models`
fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

/// 把工具调用的函数参数包成文本协议的指令块，追加到回答末尾。
/// 这样「结构化输出」和「文本协议」两条路最终交给前端的是同一种形态，解析逻辑不必分叉。
fn append_tool_block(full: &mut String, tool_args: &str) {
    let args = tool_args.trim();
    if args.is_empty() {
        return;
    }
    full.push_str(&format!("\n```{EDIT_BLOCK_TAG}\n{}\n```", args));
}

/// 从 `{"error": ...}` 里提取可读信息（error 可能是对象或字符串）
fn extract_error_message(v: &serde_json::Value) -> Option<String> {
    let err = v.get("error")?;
    if let Some(s) = err.as_str() {
        return Some(s.to_string());
    }
    err.get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string)
}

#[derive(Debug, PartialEq, Eq)]
enum SseParse {
    /// 一条 data 行中提取出的非空增量文本
    Delta(String),
    /// 推理型模型的思考增量（`delta.reasoning_content`）
    Reasoning(String),
    /// `data: [DONE]`
    Done,
    /// 服务端返回的错误信息
    Error(String),
    /// 尾帧携带的 token 用量
    Usage(AiUsage),
    /// 工具调用的函数参数增量（开启 use_tools 时）
    ToolArgs(String),
    /// 非 data 行，或空 delta
    Ignore,
}

/// 解析单行 SSE：按 `data:` 前缀取值，`[DONE]` 结束，取 `choices[0].delta.content`；
/// content 为空时回退到 `choices[0].delta.reasoning_content`（推理型模型）。
fn parse_sse_line(line: &str) -> SseParse {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let Some(rest) = line.strip_prefix("data:") else {
        return SseParse::Ignore;
    };
    // SSE 规范允许 "data:" 后跟一个可选空格
    let payload = rest.strip_prefix(' ').unwrap_or(rest).trim();
    if payload.is_empty() {
        return SseParse::Ignore;
    }
    if payload == "[DONE]" {
        return SseParse::Done;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return SseParse::Ignore;
    };
    if let Some(msg) = extract_error_message(&v) {
        return SseParse::Error(msg);
    }
    let delta = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"));
    let content = delta
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if !content.is_empty() {
        return SseParse::Delta(content.to_string());
    }
    let reasoning = delta
        .and_then(|d| d.get("reasoning_content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if !reasoning.is_empty() {
        return SseParse::Reasoning(reasoning.to_string());
    }
    // 工具调用：函数名不关心（只有一个 apply_edit），只要参数的增量
    let tool_args = delta
        .and_then(|d| d.get("tool_calls"))
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("function"))
        .and_then(|f| f.get("arguments"))
        .and_then(|a| a.as_str())
        .unwrap_or("");
    if !tool_args.is_empty() {
        return SseParse::ToolArgs(tool_args.to_string());
    }
    // 内容帧走完了才看用量：部分服务商（含带 null usage 的流式实现）会在每一帧都带上 usage 字段，
    // 先判用量会把正常内容帧当成空帧丢掉。只有拿到了完整用量才算一条 Usage 事件。
    if let Some(u) = v.get("usage") {
        let usage = AiUsage {
            prompt_tokens: u.get("prompt_tokens").and_then(|x| x.as_u64()).map(|x| x as u32),
            completion_tokens: u.get("completion_tokens").and_then(|x| x.as_u64()).map(|x| x as u32),
            total_tokens: u.get("total_tokens").and_then(|x| x.as_u64()).map(|x| x as u32),
        };
        if usage.is_meaningful() {
            return SseParse::Usage(usage);
        }
    }
    SseParse::Ignore
}

/// 值得在流开始前重试的状态码：限流与服务商侧故障通常是瞬时的
fn retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

/// 429 优先尊重服务端的 Retry-After（秒），夹在 0.2–10 秒之间；解析不出来用固定退避
fn parse_retry_after(value: Option<&str>, fallback: Duration) -> Duration {
    value
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| Duration::from_secs(secs).clamp(Duration::from_millis(200), Duration::from_secs(10)))
        .unwrap_or(fallback)
}

fn retry_after(resp: &reqwest::Response, fallback: Duration) -> Duration {
    parse_retry_after(
        resp.headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
        fallback,
    )
}

/// 依据状态码给出错误归类码，前端据此提示不同的处理办法。
/// 各家「余额不足」的文案与状态码不统一，状态码判不出来时再按关键字兜底。
fn error_code(status: u16, payload: &str) -> &'static str {
    match status {
        401 | 403 => "auth",
        429 => "rate_limit",
        402 => "quota",
        _ => {
            let lower = payload.to_lowercase();
            if lower.contains("insufficient")
                || lower.contains("balance")
                || lower.contains("quota")
                || lower.contains("余额")
            {
                "quota"
            } else if status >= 500 {
                "server"
            } else {
                "request"
            }
        }
    }
}

/// 流开始之后才报出的错误拿不到状态码，只能从文本里猜归类
fn guess_error_code(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthor")
        || lower.contains("invalid api key")
    {
        "auth"
    } else if lower.contains("429") || lower.contains("rate limit") || lower.contains("rate_limit") {
        "rate_limit"
    } else if lower.contains("insufficient")
        || lower.contains("balance")
        || lower.contains("quota")
        || lower.contains("余额")
    {
        "quota"
    } else {
        "server"
    }
}

/// HTTP 非 2xx：尽量把服务端的 error.message 提取出来，否则回退到响应片段
fn readable_http_error(status: u16, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = extract_error_message(&v) {
            return format!("请求失败（HTTP {status}）：{m}");
        }
    }
    let snippet: String = body.trim().chars().take(200).collect();
    if snippet.is_empty() {
        format!("请求失败（HTTP {status}）")
    } else {
        format!("请求失败（HTTP {status}）：{snippet}")
    }
}

/// 解析非流式补全响应：取 `choices[0].message.content`。
/// content 为空（推理型模型把 tokens 全用在思考上）时仍算连通——HTTP 200 且有 choices，
/// 说明地址、鉴权、模型三者都已被服务端接受。
fn parse_completion_text(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("响应解析失败：{e}"))?;
    if let Some(m) = extract_error_message(&v) {
        return Err(m);
    }
    let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
        return Err("服务返回了空响应".to_string());
    };
    let text = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if text.is_empty() {
        // 推理型模型（deepseek-flash / deepseek-reasoner）：内容可能在 reasoning_content
        let reasoning = choice
            .get("message")
            .and_then(|m| m.get("reasoning_content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        if reasoning.is_empty() {
            Ok("模型已响应".to_string())
        } else {
            Ok("推理型模型已响应".to_string())
        }
    } else {
        Ok(text.to_string())
    }
}

/// 取「生效 key」：系统凭据库优先；为空则回退 config.json 明文，
/// 并在读到时尝试一次性迁移（写入凭据库成功后清空 config.json 明文；失败则保持明文回退）。
fn effective_api_key(app: &tauri::AppHandle) -> String {
    if let Some(key) = secret::load_key().filter(|k| !k.trim().is_empty()) {
        return key;
    }
    let mut app_cfg = files::load_app_config(app);
    let plain = app_cfg
        .ai
        .as_ref()
        .map(|a| a.api_key.clone())
        .unwrap_or_default();
    if plain.trim().is_empty() {
        return String::new();
    }
    // 迁移：明文写入凭据库成功后，把 config.json 的明文清空并写回（一次性）
    if secret::store_key(&plain) {
        if let Some(ai) = app_cfg.ai.as_mut() {
            ai.api_key = String::new();
        }
        match files::save_app_config(app, &app_cfg) {
            Ok(()) => tracing::info!("api key migrated out of config.json"),
            Err(e) => tracing::warn!("clear plaintext api key in config failed: {e}"),
        }
    }
    plain
}

/// 读配置并校验：base_url / api_key 为空时返回统一错误
fn effective_ai(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let mut ai = files::load_app_config(app).ai.unwrap_or_default();
    ai.api_key = effective_api_key(app);
    // 档位覆盖：选中某个档位时，用它的地址 / 模型 / 温度（字段为空的档位项保持原值）
    if !ai.active_profile.trim().is_empty() {
        if let Some(p) = ai.profiles.iter().find(|p| p.id == ai.active_profile).cloned() {
            if !p.base_url.trim().is_empty() {
                ai.base_url = p.base_url;
            }
            if !p.model.trim().is_empty() {
                ai.model = p.model;
            }
            ai.temperature = p.temperature;
        }
    }
    if ai.base_url.trim().is_empty() || ai.api_key.trim().is_empty() {
        return Err(NOT_CONFIGURED.to_string());
    }
    Ok(ai)
}

/// 只设 connect_timeout（约 15s），不设全局总超时：流式响应可能持续很久
fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_single_delta_line() {
        let line = r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#;
        assert_eq!(parse_sse_line(line), SseParse::Delta("你好".to_string()));
    }

    #[test]
    fn parse_sse_reasoning_line() {
        // 推理型模型：content 为空、reasoning_content 有内容 → 归为 Reasoning
        let line = r#"data: {"choices":[{"delta":{"content":"","reasoning_content":"思考中"}}]}"#;
        assert_eq!(
            parse_sse_line(line),
            SseParse::Reasoning("思考中".to_string())
        );
        // 两者都有时 content 优先
        let line = r#"data: {"choices":[{"delta":{"content":"答案","reasoning_content":"思考"}}]}"#;
        assert_eq!(parse_sse_line(line), SseParse::Delta("答案".to_string()));
    }

    #[test]
    fn parse_sse_multiline_block() {
        let text = r#"data: {"choices":[{"delta":{"content":"a"}}]}

data: {"choices":[{"delta":{"content":"b"}}]}

data: [DONE]
"#;
        // 空行/非 data 行都会被 Ignore；保留有效事件
        let meaningful: Vec<SseParse> = text
            .lines()
            .map(parse_sse_line)
            .filter(|e| *e != SseParse::Ignore)
            .collect();
        assert_eq!(
            meaningful,
            vec![
                SseParse::Delta("a".to_string()),
                SseParse::Delta("b".to_string()),
                SseParse::Done,
            ]
        );
    }

    #[test]
    fn parse_sse_done_and_ignored_lines() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseParse::Done);
        assert_eq!(parse_sse_line("data:[DONE]"), SseParse::Done);
        assert_eq!(parse_sse_line(": keep-alive"), SseParse::Ignore);
        assert_eq!(parse_sse_line("event: message"), SseParse::Ignore);
        // 有 choices 但 delta 为空（如首帧/尾帧）：忽略
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{}}]}"#),
            SseParse::Ignore
        );
    }

    #[test]
    fn parse_sse_usage_frame() {
        let line = r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}"#;
        assert_eq!(
            parse_sse_line(line),
            SseParse::Usage(AiUsage {
                prompt_tokens: Some(12),
                completion_tokens: Some(34),
                total_tokens: Some(46),
            })
        );
    }

    #[test]
    fn parse_sse_tool_call_arguments() {
        let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"op\":"}}]}}]}"#;
        assert_eq!(parse_sse_line(line), SseParse::ToolArgs("{\"op\":".to_string()));
    }

    #[test]
    fn append_tool_block_wraps_arguments() {
        let mut full = "正文".to_string();
        append_tool_block(&mut full, r#"{"op":"insert_at_cursor","summary":"加一句","content":"新内容"}"#);
        assert!(full.starts_with("正文"));
        assert!(full.contains(&format!("```{EDIT_BLOCK_TAG}")));
        assert!(full.ends_with("```"));
        // 空参数不追加任何内容
        let mut unchanged = "只有正文".to_string();
        append_tool_block(&mut unchanged, "   ");
        assert_eq!(unchanged, "只有正文");
    }

    #[test]
    fn parse_sse_null_usage_is_ignored() {
        // 每帧都带 usage:null 的服务商：不能把内容帧吞掉，也不产生用量事件
        let line = r#"data: {"choices":[{"delta":{"content":"好"}}],"usage":null}"#;
        assert_eq!(parse_sse_line(line), SseParse::Delta("好".to_string()));
        assert_eq!(parse_sse_line(r#"data: {"choices":[],"usage":null}"#), SseParse::Ignore);
    }

    #[test]
    fn parse_sse_error_payload() {
        let line = r#"data: {"error":{"message":"invalid api key","type":"auth"}}"#;
        assert_eq!(
            parse_sse_line(line),
            SseParse::Error("invalid api key".to_string())
        );
        let v: serde_json::Value = serde_json::from_str(r#"{"error":"boom"}"#).unwrap();
        assert_eq!(extract_error_message(&v).as_deref(), Some("boom"));
    }

    #[test]
    fn mask_api_key_short_is_all_stars() {
        assert_eq!(mask_api_key(""), "");
        assert_eq!(mask_api_key("abc"), "***");
        assert_eq!(mask_api_key("12345678"), "********");
    }

    #[test]
    fn mask_api_key_long_keeps_head_and_tail() {
        assert_eq!(mask_api_key("sk-1234567890abcdef"), "sk-****cdef");
        assert_eq!(mask_api_key("sk-123456789"), "sk-****6789");
    }

    #[test]
    fn old_config_without_ai_field_deserializes() {
        // 旧 config.json 完全没有 ai 字段
        let cfg: files::AppConfig =
            serde_json::from_str(r#"{"custom_data_dir":"D:/data"}"#).unwrap();
        assert!(cfg.ai.is_none());
        // 完全空的配置
        let cfg: files::AppConfig = serde_json::from_str("{}").unwrap();
        assert!(cfg.ai.is_none());
    }

    #[test]
    fn empty_ai_object_uses_defaults() {
        let cfg: files::AppConfig = serde_json::from_str(r#"{"ai":{}}"#).unwrap();
        let ai = cfg.ai.expect("ai should deserialize from empty object");
        assert!(!ai.enabled);
        assert_eq!(ai.max_chars, 8000);
        assert!(ai.api_key.is_empty());
    }

    #[test]
    fn models_url_trims_trailing_slash_only() {
        assert_eq!(models_url("https://api.deepseek.com"), "https://api.deepseek.com/models");
        assert_eq!(models_url("https://api.openai.com/v1/"), "https://api.openai.com/v1/models");
    }

    #[test]
    fn chat_url_trims_trailing_slash_only() {
        assert_eq!(
            chat_url("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            chat_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn parse_completion_text_reads_message_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"pong"}}]}"#;
        assert_eq!(parse_completion_text(body).unwrap(), "pong");
        assert!(parse_completion_text(r#"{"error":{"message":"nope"}}"#).is_err());
        // 推理型模型：max_tokens 全用在思考上，content 为空但仍算连通
        let body =
            r#"{"choices":[{"message":{"content":"","reasoning_content":"We need answer"}}]}"#;
        assert_eq!(parse_completion_text(body).unwrap(), "推理型模型已响应");
        assert_eq!(
            parse_completion_text(r#"{"choices":[{"message":{"content":""}}]}"#).unwrap(),
            "模型已响应"
        );
        // 没有 choices → 视为异常响应
        assert!(parse_completion_text(r#"{"foo":1}"#).is_err());
    }

    #[test]
    fn retryable_status_covers_rate_limit_and_server_errors() {
        assert!(retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR));
        assert!(retryable_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!retryable_status(reqwest::StatusCode::UNAUTHORIZED));
        assert!(!retryable_status(reqwest::StatusCode::BAD_REQUEST));
    }

    #[test]
    fn parse_retry_after_clamps_seconds_and_falls_back() {
        let fb = Duration::from_secs(1);
        assert_eq!(parse_retry_after(Some("5"), fb), Duration::from_secs(5));
        // 上限 10 秒、下限 0.2 秒，避免恶意/异常头把界面卡死
        assert_eq!(parse_retry_after(Some("600"), fb), Duration::from_secs(10));
        assert_eq!(parse_retry_after(Some("0"), fb), Duration::from_millis(200));
        assert_eq!(parse_retry_after(Some("not-a-number"), fb), fb);
        assert_eq!(parse_retry_after(None, fb), fb);
    }
}
