//! AI 助手：读取/保存 AI 配置、连通性测试，以及走 OpenAI 兼容协议的流式对话。
//!
//! openai / deepseek / qwen / kimi / ollama 等都暴露同一套接口：
//! `POST {base_url}/chat/completions`，鉴权 `Authorization: Bearer <key>`，响应为 SSE。
//! base_url 由用户填写（可能已含 /v1），这里只去掉结尾 `/` 后原样拼 `/chat/completions`。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use super::files::{self, AiConfig};

/// 流式请求的「世代」计数：ai_cancel 自增后，正在跑的 ai_chat 会发现自己记录的世代已过期而中断。
static AI_GENERATION: AtomicU64 = AtomicU64::new(0);

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

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    Chunk { delta: String },
    Done { full: String },
    Error { message: String },
}

/// 回传前端的配置（绝不包含明文 api_key）
#[derive(Serialize)]
pub struct AiConfigPublic {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub max_chars: u32,
    pub has_api_key: bool,
    pub api_key_masked: String,
}

/// 前端保存配置的入参：api_key 为 None 时保持原值、Some("") 清空、Some(s) 覆盖
#[derive(Deserialize)]
pub struct AiConfigInput {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub max_chars: u32,
    pub api_key: Option<String>,
}

// ---------- 命令 ----------

/// 读取 AI 配置（掩码返回，不泄露 key）
#[tauri::command]
pub fn ai_get_config(app: tauri::AppHandle) -> Result<AiConfigPublic, String> {
    Ok(public_of(&files::load_app_config(&app)))
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
    // None 保持原值不变；Some("") 清空；Some(s) 覆盖
    if let Some(key) = cfg.api_key {
        ai.api_key = key;
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
    let resp = client
        .post(chat_url(&ai.base_url))
        .bearer_auth(&ai.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败：{e}"))?;
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
    let body = serde_json::json!({
        "model": ai.model,
        "messages": req.messages,
        "stream": true,
    });
    let resp = match client
        .post(chat_url(&ai.base_url))
        .bearer_auth(&ai.api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiEvent::Error {
                message: format!("连接失败：{e}"),
            });
            return Ok(());
        }
    };
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let _ = on_event.send(AiEvent::Error {
            message: readable_http_error(status.as_u16(), &text),
        });
        return Ok(());
    }

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    // SSE 事件可能跨多个字节块到达：按行切分，未成行的残留留到下一轮。
    // 累积字节而非字符串，避免多字节 UTF-8（中文）被拆到两个块时解码成乱码。
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();

    while let Some(item) = stream.next().await {
        if cancelled(generation) {
            let _ = on_event.send(AiEvent::Error {
                message: "cancelled".to_string(),
            });
            return Ok(());
        }
        match item {
            Ok(bytes) => buf.extend_from_slice(&bytes),
            Err(e) => {
                let _ = on_event.send(AiEvent::Error {
                    message: format!("读取流失败：{e}"),
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
                        });
                        return Ok(());
                    }
                    full.push_str(&delta);
                    if on_event.send(AiEvent::Chunk { delta }).is_err() {
                        return Ok(());
                    }
                }
                SseParse::Error(message) => {
                    let _ = on_event.send(AiEvent::Error { message });
                    return Ok(());
                }
                SseParse::Done => {
                    let _ = on_event.send(AiEvent::Done { full });
                    return Ok(());
                }
                SseParse::Ignore => {}
            }
        }
    }
    // 服务端未发 [DONE] 就断流：按正常结束处理，把已收到的内容交给前端
    let _ = on_event.send(AiEvent::Done { full });
    Ok(())
}

// ---------- 纯函数（便于离线单测） ----------

fn cancelled(generation: u64) -> bool {
    AI_GENERATION.load(Ordering::SeqCst) != generation
}

/// 从 AppConfig 构造回传前端的掩码视图
fn public_of(cfg: &files::AppConfig) -> AiConfigPublic {
    let ai = cfg.ai.clone().unwrap_or_default();
    AiConfigPublic {
        enabled: ai.enabled,
        provider: ai.provider,
        base_url: ai.base_url,
        model: ai.model,
        max_chars: ai.max_chars,
        has_api_key: !ai.api_key.is_empty(),
        api_key_masked: mask_api_key(&ai.api_key),
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
    /// `data: [DONE]`
    Done,
    /// 服务端返回的错误信息
    Error(String),
    /// 非 data 行，或空 delta
    Ignore,
}

/// 解析单行 SSE：按 `data:` 前缀取值，`[DONE]` 结束，取 `choices[0].delta.content`。
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
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if delta.is_empty() {
        SseParse::Ignore
    } else {
        SseParse::Delta(delta.to_string())
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

/// 解析非流式补全响应，取 `choices[0].message.content`
fn parse_completion_text(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("响应解析失败：{e}"))?;
    if let Some(m) = extract_error_message(&v) {
        return Err(m);
    }
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if text.is_empty() {
        Err("服务返回了空响应".to_string())
    } else {
        Ok(text.to_string())
    }
}

/// 读配置并校验：base_url / api_key 为空时返回统一错误
fn effective_ai(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let ai = files::load_app_config(app).ai.unwrap_or_default();
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
    }
}
