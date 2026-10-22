//! 服务商协议适配：OpenAI 兼容 / Anthropic / Gemini 三家的请求构造与 SSE 帧解析。
//!
//! 前端与 agent 循环只认 OpenAI 风格的消息数组和事件流（chunk / reasoning / done / error），
//! 换一家协议只改这一处：出去时把统一消息数组翻译成各家形态，进来时把各家的帧翻译回统一事件。
//! 工具调用、多步 agent 循环、停止/重试这些逻辑因此不用为每家协议重写一遍。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::ai::{
    extract_error_message, parse_completion_text, parse_sse_line, AiMessage, AiUsage, SseParse,
};
use super::files::AiConfig;

mod providers;
mod sse;

pub use sse::*;
// 三家的请求体构造只在父模块的 chat() 里分派；pub use 的 glob 不透出 pub(super) 项，故显式引入。
use providers::{anthropic_body, gemini_body, openai_body};

/// Anthropic Messages API 用日期做版本号，请求头必须带
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic 的 max_tokens 是必填项：用户没设上限时给一个足够大的值
const ANTHROPIC_FALLBACK_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// POST {base_url}/chat/completions：openai / deepseek / qwen / kimi / ollama 及各类网关
    OpenAi,
    /// POST {root}/v1/messages：Anthropic 原生
    Anthropic,
    /// POST {root}/v1beta/models/{model}:streamGenerateContent：Google Gemini 原生
    Gemini,
}

impl Protocol {
    /// 设置里显式选了协议就用它；留空（auto）时按 base_url 认厂商域名，认不出按 OpenAI 兼容处理。
    /// auto 让「用档位切服务商」不至于因为协议没跟着改而打错接口。
    pub fn resolve(configured: &str, base_url: &str) -> Protocol {
        match configured.trim().to_ascii_lowercase().as_str() {
            "anthropic" | "claude" => Protocol::Anthropic,
            "gemini" | "google" => Protocol::Gemini,
            "openai" => Protocol::OpenAi,
            _ => Protocol::detect(base_url),
        }
    }

    fn detect(base_url: &str) -> Protocol {
        let lower = base_url.to_ascii_lowercase();
        if lower.contains("anthropic") {
            Protocol::Anthropic
        } else if lower.contains("generativelanguage") || lower.contains("gemini") {
            Protocol::Gemini
        } else {
            Protocol::OpenAi
        }
    }
}

/// 一个接口的地址与鉴权头（三家鉴权方式不同，其余共用）
pub struct Endpoint {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

impl Endpoint {
    /// 把鉴权头挂到请求上：OpenAI 用 Bearer，Anthropic / Gemini 用各自的自定义头
    pub fn apply(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        self.headers
            .iter()
            .fold(req, |r, (k, v)| r.header(k.as_str(), v.as_str()))
    }
}

/// 按协议拼鉴权头。Key 为空时**不发**鉴权头：本地模型（Ollama / LM Studio）不吃 Key，
/// 而空的 `Bearer ` / `x-api-key:` 会被部分网关判成格式错误的凭据直接 401。
/// anthropic-version 是协议要求而非凭据，与 Key 无关，照常下发。
fn headers_for(ai: &AiConfig, protocol: Protocol) -> Vec<(String, String)> {
    let key = ai.api_key.trim();
    match protocol {
        Protocol::OpenAi => {
            if key.is_empty() {
                Vec::new()
            } else {
                vec![("authorization".to_string(), format!("Bearer {key}"))]
            }
        }
        Protocol::Anthropic => {
            let mut headers = Vec::new();
            if !key.is_empty() {
                headers.push(("x-api-key".to_string(), key.to_string()));
            }
            headers.push((
                "anthropic-version".to_string(),
                ANTHROPIC_VERSION.to_string(),
            ));
            headers
        }
        Protocol::Gemini => {
            if key.is_empty() {
                Vec::new()
            } else {
                vec![("x-goog-api-key".to_string(), key.to_string())]
            }
        }
    }
}

/// 用户显式关闭思考（auto = 不下发任何推理参数，维持历史行为）
fn thinking_off(ai: &AiConfig) -> bool {
    ai.thinking.eq_ignore_ascii_case("off")
}

/// 会话接口：地址 + 请求体。`stream=false` 用于连通性测试。
pub fn chat(
    ai: &AiConfig,
    protocol: Protocol,
    messages: Vec<AiMessage>,
    tools: Option<Value>,
    stream: bool,
) -> (Endpoint, Value) {
    let endpoint = match protocol {
        Protocol::OpenAi => Endpoint {
            url: format!("{}/chat/completions", tail(&ai.base_url)),
            headers: headers_for(ai, protocol),
        },
        Protocol::Anthropic => Endpoint {
            url: format!("{}/messages", anthropic_root(&ai.base_url)),
            headers: headers_for(ai, protocol),
        },
        Protocol::Gemini => Endpoint {
            url: gemini_call_url(&ai.base_url, &ai.model, stream),
            headers: headers_for(ai, protocol),
        },
    };
    let body = match protocol {
        Protocol::OpenAi => openai_body(ai, &messages, tools, stream),
        Protocol::Anthropic => anthropic_body(ai, &messages, tools, stream),
        Protocol::Gemini => gemini_body(ai, &messages, tools),
    };
    (endpoint, body)
}

/// 模型列表接口（GET，无请求体）
pub fn models(ai: &AiConfig, protocol: Protocol) -> Endpoint {
    match protocol {
        Protocol::OpenAi => Endpoint {
            url: format!("{}/models", tail(&ai.base_url)),
            headers: headers_for(ai, protocol),
        },
        Protocol::Anthropic => Endpoint {
            url: format!("{}/models", anthropic_root(&ai.base_url)),
            headers: headers_for(ai, protocol),
        },
        Protocol::Gemini => Endpoint {
            url: format!("{}/models", gemini_root(&ai.base_url)),
            headers: headers_for(ai, protocol),
        },
    }
}

/// 去掉结尾的 `/`。OpenAI 兼容路径保留用户写的 `/v1`（那是地址的一部分，历史上就原样拼接）。
fn tail(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

/// Anthropic 根：`https://api.anthropic.com` 与 `https://api.anthropic.com/v1` 都归一到后者。
/// 用户常从文档里整段复制 URL，所以已经拼好的 `/messages` 尾巴也要剥掉。
fn anthropic_root(base_url: &str) -> String {
    let mut t = tail(base_url)
        .trim_end_matches("/messages")
        .trim_end_matches('/')
        .to_string();
    if !t.ends_with("/v1") {
        t.push_str("/v1");
    }
    t
}

/// Gemini 根：v1beta 是常用前缀，用户填 `/v1` 也照收（两家都在版本段下挂 /models）
fn gemini_root(base_url: &str) -> String {
    let t = tail(base_url)
        .trim_end_matches("/models")
        .trim_end_matches('/')
        .to_string();
    if t.ends_with("/v1beta") || t.ends_with("/v1") {
        t
    } else {
        format!("{t}/v1beta")
    }
}

fn gemini_call_url(base_url: &str, model: &str, stream: bool) -> String {
    let verb = if stream {
        ":streamGenerateContent?alt=sse"
    } else {
        ":generateContent"
    };
    format!("{}/models/{model}{verb}", gemini_root(base_url))
}

/// 把 system 消息从会话数组里拿出来：Anthropic 的 system 是顶层字段，Gemini 是
/// systemInstruction，都放不进 role 循环。多条 system 按原顺序拼成一整段（内容不丢，顺序改变）。
fn split_system(messages: &[AiMessage]) -> (String, Vec<&AiMessage>) {
    let mut system: Vec<&str> = Vec::new();
    let mut turns = Vec::new();
    for m in messages {
        if m.role == "system" {
            if !m.content.trim().is_empty() {
                system.push(m.content.trim());
            }
        } else {
            turns.push(m);
        }
    }
    (system.join("\n\n"), turns)
}

/// tool_call_id → 工具名。Gemini 的 functionResponse 只认名字不认 id，得从历史里的
/// assistant.tool_calls 反查；Anthropic 的 tool_result 用 id，不需要这张表。
fn tool_names(messages: &[AiMessage]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for m in messages {
        for call in m.tool_calls.iter().flatten() {
            map.insert(call.id.clone(), call.name.clone());
        }
    }
    map
}

/// 参数按各家协议都要对象形态。解析不出来时给空对象，让服务端报「参数不符 schema」，
/// 而不是在这里造出一个畸形 JSON 把整轮请求带崩。
fn parse_arguments(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw.trim())
        .ok()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

fn tools_of(tools: Option<Value>) -> Option<Vec<Value>> {
    match tools {
        Some(Value::Array(list)) if !list.is_empty() => Some(list),
        _ => None,
    }
}

/// 一条工具定义取回 (name, description, parameters)：兼容 {type:"function",function:{…}}
/// 与平铺 {name,…} 两种写法
fn tool_parts(spec: &Value) -> Option<(String, String, Value)> {
    let f = spec.get("function").unwrap_or(spec);
    let name = f
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())?;
    let description = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
    let parameters = f
        .get("parameters")
        .or_else(|| f.get("input_schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    Some((name.to_string(), description.to_string(), parameters))
}

/// 公共的 model / temperature / max_tokens 骨架
fn skeleton(ai: &AiConfig) -> Value {
    json!({
        "model": ai.model,
        "temperature": ai.temperature.clamp(0.0, 2.0),
    })
}

#[cfg(test)]
mod tests;
