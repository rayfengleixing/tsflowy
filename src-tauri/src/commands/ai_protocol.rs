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

// ---------- OpenAI 兼容 ----------

fn openai_body(ai: &AiConfig, messages: &[AiMessage], tools: Option<Value>, stream: bool) -> Value {
    let mut body = skeleton(ai);
    body["messages"] = json!(openai_messages(messages));
    if stream {
        // 让支持的服务商在尾帧回传 token 用量；不支持的会忽略这个字段
        body["stream"] = json!(true);
        body["stream_options"] = json!({ "include_usage": true });
    }
    // max_tokens 为 0 时不下发（用服务端默认）
    if ai.max_tokens > 0 {
        body["max_tokens"] = json!(ai.max_tokens);
    }
    // 关闭思考：OpenAI 兼容家族没有统一参数——官方 API 的 reasoning_effort 只认推理模型
    // （发给非推理模型直接 400），Ollama 的 think、LM Studio 的 chat_template_kv 又各成一套。
    // 无法判定端点方言，宁可不发（auto 语义即维持现状）；需要精确关闭请用 Anthropic / Gemini 协议。
    // 工具定义由前端下发（agent 工具集在前端定义与执行），原样透传
    if let Some(list) = tools_of(tools) {
        body["tools"] = json!(list);
        body["tool_choice"] = json!("auto");
    }
    body
}

/// 消息数组 → OpenAI 兼容形态。带图时 content 换成 parts 数组（`image_url` 收 data URL，
/// 兼容端点普遍支持），不带图时保持纯字符串内容，避免动到既有请求体形态。
fn openai_messages(messages: &[AiMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            let mut v = json!(m);
            let Some(obj) = v.as_object_mut() else { return v };
            obj.remove("images");
            if !m.images.is_empty() {
                let mut parts = vec![json!({ "type": "text", "text": m.content })];
                parts.extend(m.images.iter().map(|img| {
                    json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{};base64,{}", img.media_type, img.data) },
                    })
                }));
                obj.insert("content".to_string(), json!(parts));
            }
            v
        })
        .collect()
}

// ---------- Anthropic ----------

fn anthropic_body(
    ai: &AiConfig,
    messages: &[AiMessage],
    tools: Option<Value>,
    stream: bool,
) -> Value {
    let (system, turns) = split_system(messages);
    let mut body = skeleton(ai);
    body["max_tokens"] = json!(if ai.max_tokens > 0 {
        ai.max_tokens
    } else {
        ANTHROPIC_FALLBACK_MAX_TOKENS
    });
    body["messages"] = json!(anthropic_messages(&turns));
    if stream {
        body["stream"] = json!(true);
    }
    // 官方 Messages API 用 thinking.type=disabled 显式关闭扩展思考
    if thinking_off(ai) {
        body["thinking"] = json!({ "type": "disabled" });
    }
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if let Some(list) = tools_of(tools) {
        let decl: Vec<Value> = list
            .iter()
            .filter_map(tool_parts)
            .map(|(name, description, parameters)| {
                json!({ "name": name, "description": description, "input_schema": parameters })
            })
            .collect();
        if !decl.is_empty() {
            body["tools"] = json!(decl);
            body["tool_choice"] = json!({ "type": "auto" });
        }
    }
    body
}

/// 消息数组 → 内容块形态，并把相邻同角色合并：
/// Anthropic 要求 user / assistant 严格交替，而 agent 循环里连着两条 user（工具结果 + 用户补问）是常态。
fn anthropic_messages(turns: &[&AiMessage]) -> Vec<Value> {
    let mut grouped: Vec<(&str, Vec<Value>)> = Vec::new();
    for m in turns {
        let role = if m.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        let blocks = anthropic_blocks(m);
        if blocks.is_empty() {
            continue;
        }
        match grouped.last_mut().filter(|(r, _)| *r == role) {
            Some((_, list)) => list.extend(blocks),
            None => grouped.push((role, blocks)),
        }
    }
    grouped
        .into_iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect()
}

fn anthropic_blocks(m: &AiMessage) -> Vec<Value> {
    // 工具结果：user 消息里的 tool_result 块，靠 tool_call_id 与之前的 tool_use 配对
    if m.role == "tool" {
        return vec![json!({
            "type": "tool_result",
            "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
            "content": m.content,
        })];
    }
    let mut blocks = Vec::new();
    // Anthropic 建议图片放在文本之前：先看结论再读问题，命中率更高
    blocks.extend(m.images.iter().map(|img| {
        json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.media_type, "data": img.data },
        })
    }));
    if !m.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": m.content }));
    }
    for call in m.tool_calls.iter().flatten() {
        blocks.push(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": parse_arguments(&call.arguments),
        }));
    }
    blocks
}

// ---------- Gemini ----------

fn gemini_body(ai: &AiConfig, messages: &[AiMessage], tools: Option<Value>) -> Value {
    let (system, turns) = split_system(messages);
    let names = tool_names(messages);
    let mut body = skeleton(ai);
    body["contents"] = json!(turns
        .iter()
        .filter_map(|m| gemini_turn(m, &names))
        .collect::<Vec<_>>());
    if ai.max_tokens > 0 {
        body["generationConfig"]["maxOutputTokens"] = json!(ai.max_tokens);
    }
    // 官方文档：thinkingBudget=0 关闭思考（2.5 Flash 系），includeThoughts=false 双保险
    if thinking_off(ai) {
        body["generationConfig"]["thinkingConfig"] =
            json!({ "thinkingBudget": 0, "includeThoughts": false });
    }
    if !system.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if let Some(list) = tools_of(tools) {
        let decl: Vec<Value> = list
            .iter()
            .filter_map(tool_parts)
            .map(|(name, description, parameters)| {
                json!({
                    "name": name,
                    "description": description,
                    // Gemini 的 schema 类型名是大写枚举（OBJECT / STRING / …）
                    "parameters": gemini_schema(&parameters),
                })
            })
            .collect();
        if !decl.is_empty() {
            body["tools"] = json!([{ "functionDeclarations": decl }]);
            body["toolConfig"] = json!({ "functionCallingConfig": { "mode": "AUTO" } });
        }
    }
    body
}

/// 把 OpenAI 风格的 JSON schema 改成 Gemini 认的形式：递归把 type 的枚举值转大写。
/// 其它键（additionalProperties 之类）原样保留，Gemini 会忽略。
fn gemini_schema(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                if k == "type" {
                    if let Some(s) = val.as_str() {
                        out.insert(k.clone(), json!(s.to_ascii_uppercase()));
                        continue;
                    }
                }
                out.insert(k.clone(), gemini_schema(val));
            }
            Value::Object(out)
        }
        Value::Array(list) => Value::Array(list.iter().map(gemini_schema).collect()),
        other => other.clone(),
    }
}

fn gemini_turn(m: &AiMessage, names: &BTreeMap<String, String>) -> Option<Value> {
    // 工具结果：functionResponse 部件，按官方 SDK 的做法以 user 角色送回
    if m.role == "tool" {
        let name = m
            .tool_call_id
            .as_ref()
            .and_then(|id| names.get(id))
            .cloned()
            .unwrap_or_else(|| "tool".to_string());
        return Some(json!({
            "role": "user",
            "parts": [{ "functionResponse": { "name": name, "response": { "result": m.content } } }],
        }));
    }
    let role = if m.role == "assistant" {
        "model"
    } else {
        "user"
    };
    let mut parts: Vec<Value> = Vec::new();
    parts.extend(
        m.images
            .iter()
            .map(|img| json!({ "inlineData": { "mimeType": img.media_type, "data": img.data } })),
    );
    if !m.content.is_empty() {
        parts.push(json!({ "text": m.content }));
    }
    for call in m.tool_calls.iter().flatten() {
        parts.push(json!({
            "functionCall": {
                "name": call.name,
                "args": parse_arguments(&call.arguments),
                "id": call.id,
            }
        }));
    }
    if parts.is_empty() {
        return None;
    }
    Some(json!({ "role": role, "parts": parts }))
}

// ---------- 非流式响应解析（连通性测试 / 模型列表） ----------

/// 非流式补全响应 → 可读文本
pub fn completion_text(protocol: Protocol, body: &str) -> Result<String, String> {
    if protocol == Protocol::OpenAi {
        return parse_completion_text(body);
    }
    let v: Value = serde_json::from_str(body).map_err(|e| format!("响应解析失败：{e}"))?;
    if let Some(m) = extract_error_message(&v) {
        return Err(m);
    }
    let blocks: Vec<&Value> = match protocol {
        Protocol::Anthropic => vec_of(v.get("content")),
        Protocol::Gemini => vec_of(
            v.get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts")),
        ),
        Protocol::OpenAi => Vec::new(),
    };
    let text: String = blocks
        .iter()
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect();
    // HTTP 200 且结构正常就算连通：正文为空多半是 tokens 全花在了思考上
    if text.is_empty() {
        Ok("模型已响应".to_string())
    } else {
        Ok(text)
    }
}

fn vec_of(v: Option<&Value>) -> Vec<&Value> {
    v.and_then(|x| x.as_array())
        .map(|arr| arr.iter().collect())
        .unwrap_or_default()
}

/// 模型列表响应 → 模型 id 列表
pub fn model_ids(protocol: Protocol, body: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let items: Vec<&Value> = match protocol {
        Protocol::Gemini => vec_of(v.get("models")),
        _ => vec_of(v.get("data")),
    };
    let mut out: Vec<String> = items
        .iter()
        .filter_map(|m| {
            m.get("id")
                .or_else(|| m.get("name"))
                .and_then(|i| i.as_str())
                .map(str::to_string)
        })
        // Gemini 的 name 形如 "models/gemini-2.5-flash"，请求里只用短名
        .map(|id| id.strip_prefix("models/").unwrap_or(&id).to_string())
        .filter(|id| !id.is_empty())
        .collect();
    out.sort();
    out
}

// ---------- SSE 帧解析 ----------

/// 逐行解码器：三家都往 SSE 里塞各自的 JSON，统一翻译成 `SseParse` 事件。
/// 有状态是因为 Gemini 一帧里可能带多个部件（正文 + 若干函数调用），
/// 需要一个跨帧递增的序号把它们分到不同的 index 上。
pub struct SseDecoder {
    protocol: Protocol,
    gemini_calls: u32,
}

impl SseDecoder {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            gemini_calls: 0,
        }
    }

    /// 一行 → 0 或多个事件（同一行里既有正文增量又有函数调用时都给出去）
    pub fn decode(&mut self, line: &str) -> Vec<SseParse> {
        if self.protocol == Protocol::OpenAi {
            return parse_sse_line(line)
                .into_iter()
                .filter(|e| *e != SseParse::Ignore)
                .collect();
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(rest) = line.strip_prefix("data:") else {
            return Vec::new();
        };
        // SSE 规范允许 "data:" 后跟一个可选空格
        let payload = rest.strip_prefix(' ').unwrap_or(rest).trim();
        if payload.is_empty() {
            return Vec::new();
        }
        if payload == "[DONE]" {
            return vec![SseParse::Done];
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            return Vec::new();
        };
        if let Some(msg) = extract_error_message(&v) {
            return vec![SseParse::Error(msg)];
        }
        match self.protocol {
            Protocol::Anthropic => anthropic_events(&v),
            Protocol::Gemini => self.gemini_events(&v),
            Protocol::OpenAi => Vec::new(),
        }
    }

    /// Gemini 的一帧里可能同时有正文部件与函数调用部件，逐个翻译
    fn gemini_events(&mut self, v: &Value) -> Vec<SseParse> {
        let mut out = Vec::new();
        for candidate in vec_of(v.get("candidates")) {
            for part in vec_of(candidate.get("content").and_then(|c| c.get("parts"))) {
                let text = part.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if !text.is_empty() {
                    // 深度思考模型的思考过程带 thought:true
                    if part.get("thought").and_then(|t| t.as_bool()) == Some(true) {
                        out.push(SseParse::Reasoning(text.to_string()));
                    } else {
                        out.push(SseParse::Delta(text.to_string()));
                    }
                }
                if let Some(call) = part.get("functionCall") {
                    let name = call
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    // Gemini 的 args 是现成的对象，整帧一次给全，不需要像 OpenAI 那样按帧拼接
                    let args = call
                        .get("args")
                        .map(|a| a.to_string())
                        .unwrap_or_else(|| "{}".to_string());
                    let id = call
                        .get("id")
                        .and_then(|i| i.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("call_{name}"));
                    out.push(SseParse::ToolCallDelta {
                        index: self.gemini_calls,
                        id: Some(id),
                        name: Some(name),
                        args,
                    });
                    self.gemini_calls += 1;
                }
            }
        }
        if let Some(meta) = v.get("usageMetadata") {
            let num = |k: &str| meta.get(k).and_then(|x| x.as_u64()).map(|x| x as u32);
            let usage = AiUsage {
                prompt_tokens: num("promptTokenCount"),
                completion_tokens: num("candidatesTokenCount"),
                total_tokens: num("totalTokenCount"),
            };
            if usage.is_meaningful() {
                out.push(SseParse::Usage(usage));
            }
        }
        out
    }
}

/// Anthropic 的每个 data 帧自带 type，不需要读 `event:` 行
fn anthropic_events(v: &Value) -> Vec<SseParse> {
    let mut out = Vec::new();
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "message_start" => {
            if let Some(u) = anthropic_usage(v.get("message").and_then(|m| m.get("usage"))) {
                out.push(SseParse::Usage(u));
            }
        }
        "content_block_start" => {
            let block = v.get("content_block");
            if block.and_then(|b| b.get("type")).and_then(|t| t.as_str()) == Some("tool_use") {
                let id = block
                    .and_then(|b| b.get("id"))
                    .and_then(|i| i.as_str())
                    .map(str::to_string);
                let name = block
                    .and_then(|b| b.get("name"))
                    .and_then(|n| n.as_str())
                    .map(str::to_string);
                out.push(SseParse::ToolCallDelta {
                    index: block_index(v),
                    id,
                    name,
                    args: String::new(),
                });
            }
        }
        "content_block_delta" => {
            let delta = v.get("delta");
            match delta
                .and_then(|d| d.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
            {
                "text_delta" => {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            out.push(SseParse::Delta(text.to_string()));
                        }
                    }
                }
                "thinking_delta" => {
                    if let Some(text) = delta
                        .and_then(|d| d.get("thinking"))
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            out.push(SseParse::Reasoning(text.to_string()));
                        }
                    }
                }
                // 工具参数分帧到达，按内容块 index 归并（与 OpenAI 的 tool_calls index 同构）
                "input_json_delta" => {
                    let args = delta
                        .and_then(|d| d.get("partial_json"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("");
                    if !args.is_empty() {
                        out.push(SseParse::ToolCallDelta {
                            index: block_index(v),
                            id: None,
                            name: None,
                            args: args.to_string(),
                        });
                    }
                }
                // signature_delta（思考签名）等增量与回答无关，丢掉
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(u) = anthropic_usage(v.get("usage")) {
                out.push(SseParse::Usage(u));
            }
        }
        "message_stop" => out.push(SseParse::Done),
        _ => {}
    }
    out
}

fn block_index(v: &Value) -> u32 {
    v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32
}

/// input_tokens → prompt、output_tokens → completion；总数按两项相加
fn anthropic_usage(usage: Option<&Value>) -> Option<AiUsage> {
    let u = usage?;
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).map(|x| x as u32);
    let prompt = num("input_tokens");
    let completion = num("output_tokens");
    if prompt.is_none() && completion.is_none() {
        return None;
    }
    Some(AiUsage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt.zip(completion).map(|(p, c)| p + c),
    })
}

#[cfg(test)]
mod tests {
    use super::super::ai::{AiImage, AiToolCall};
    use super::*;

    fn cfg(protocol: &str, base_url: &str) -> AiConfig {
        AiConfig {
            enabled: true,
            protocol: protocol.to_string(),
            base_url: base_url.to_string(),
            model: "m-test".to_string(),
            api_key: "k-123".to_string(),
            ..Default::default()
        }
    }

    fn msg(role: &str, content: &str) -> AiMessage {
        AiMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            images: Vec::new(),
        }
    }

    /// 已内联的图片（Rust 侧按 assets 相对路径读出 base64 后的形态）
    fn image(data: &str, media_type: &str) -> AiImage {
        AiImage {
            path: "assets/pic.png".to_string(),
            media_type: media_type.to_string(),
            data: data.to_string(),
        }
    }

    fn line(payload: &str) -> String {
        format!("data: {payload}")
    }

    /// 工具结果消息：各家都靠 tool_call_id 与之前的调用配对
    fn tool_msg(id: &str, content: &str) -> AiMessage {
        let mut m = msg("tool", content);
        m.tool_call_id = Some(id.to_string());
        m
    }

    #[test]
    fn explicit_protocol_wins_over_url_detection() {
        assert_eq!(
            Protocol::resolve("anthropic", "https://gateway.example.com/v1"),
            Protocol::Anthropic
        );
        // 留空 = auto：按域名认厂商，认不出才是 OpenAI 兼容
        assert_eq!(
            Protocol::resolve("", "https://api.anthropic.com"),
            Protocol::Anthropic
        );
        assert_eq!(
            Protocol::resolve("", "https://generativelanguage.googleapis.com/v1beta"),
            Protocol::Gemini
        );
        assert_eq!(
            Protocol::resolve("", "https://api.deepseek.com/v1"),
            Protocol::OpenAi
        );
    }

    #[test]
    fn endpoints_use_protocol_specific_url_and_auth_header() {
        let (ep, _) = chat(
            &cfg("", "https://api.deepseek.com/v1"),
            Protocol::OpenAi,
            vec![],
            None,
            true,
        );
        assert_eq!(ep.url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(
            ep.headers[0],
            ("authorization".to_string(), "Bearer k-123".to_string())
        );

        let (ep, _) = chat(
            &cfg("", "https://api.anthropic.com/"),
            Protocol::Anthropic,
            vec![],
            None,
            true,
        );
        assert_eq!(ep.url, "https://api.anthropic.com/v1/messages");
        assert!(ep
            .headers
            .contains(&("x-api-key".to_string(), "k-123".to_string())));
        assert!(ep
            .headers
            .contains(&("anthropic-version".to_string(), "2023-06-01".to_string())));

        let (ep, _) = chat(
            &cfg("", "https://generativelanguage.googleapis.com"),
            Protocol::Gemini,
            vec![],
            None,
            true,
        );
        assert_eq!(
            ep.url,
            "https://generativelanguage.googleapis.com/v1beta/models/m-test:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            ep.headers[0],
            ("x-goog-api-key".to_string(), "k-123".to_string())
        );

        // 连通性测试用非流式端点
        let (ep, _) = chat(
            &cfg("", "https://a.example/v1beta"),
            Protocol::Gemini,
            vec![],
            None,
            false,
        );
        assert_eq!(
            ep.url,
            "https://a.example/v1beta/models/m-test:generateContent"
        );
    }

    #[test]
    fn base_url_with_api_path_already_appended_is_not_doubled() {
        // 用户常从文档里整段复制 URL
        let (ep, _) = chat(
            &cfg("", "https://api.anthropic.com/v1/messages"),
            Protocol::Anthropic,
            vec![],
            None,
            true,
        );
        assert_eq!(ep.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(
            models(
                &cfg("", "https://api.anthropic.com/v1"),
                Protocol::Anthropic
            )
            .url,
            "https://api.anthropic.com/v1/models"
        );
        let ep = models(
            &cfg(
                "",
                "https://generativelanguage.googleapis.com/v1beta/models",
            ),
            Protocol::Gemini,
        );
        assert_eq!(
            ep.url,
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    #[test]
    fn openai_body_keeps_previous_shape() {
        let (_, body) = chat(
            &cfg("", "https://api.deepseek.com/v1"),
            Protocol::OpenAi,
            vec![msg("system", "协议"), msg("user", "你好")],
            Some(json!([{"type": "function"}])),
            true,
        );
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["tool_choice"], json!("auto"));
        // max_tokens 为 0 时不下发
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn anthropic_body_moves_system_out_and_requires_max_tokens() {
        let (ep, body) = chat(
            &cfg("anthropic", "https://api.anthropic.com"),
            Protocol::Anthropic,
            vec![
                msg("system", "内置协议"),
                msg("user", "甲"),
                msg("system", "补充提示"),
                msg("user", "乙"),
            ],
            None,
            true,
        );
        assert_eq!(body["system"], json!("内置协议\n\n补充提示"));
        assert_eq!(body["max_tokens"], json!(ANTHROPIC_FALLBACK_MAX_TOKENS));
        // 相邻同角色合并成一条（Anthropic 要求 user / assistant 交替）
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], json!("user"));
        assert_eq!(msgs[0]["content"].as_array().unwrap().len(), 2);
        assert_eq!(ep.headers.len(), 2);
    }

    #[test]
    fn anthropic_body_translates_tool_round_trip() {
        let mut assistant = msg("assistant", "先查一下");
        assistant.tool_calls = Some(vec![AiToolCall {
            id: "toolu_1".to_string(),
            name: "search_workspace".to_string(),
            arguments: r#"{"query":"周报"}"#.to_string(),
        }]);
        let (_, body) = chat(
            &cfg("anthropic", "https://api.anthropic.com"),
            Protocol::Anthropic,
            vec![
                msg("user", "找周报"),
                assistant,
                tool_msg("toolu_1", "找到 3 篇"),
            ],
            Some(json!([
                { "type": "function", "function": { "name": "search_workspace", "description": "检索", "parameters": { "type": "object" } } }
            ])),
            true,
        );
        let msgs = body["messages"].as_array().unwrap();
        let blocks = msgs[1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], json!("text"));
        assert_eq!(blocks[1]["type"], json!("tool_use"));
        assert_eq!(blocks[1]["id"], json!("toolu_1"));
        assert_eq!(blocks[1]["input"], json!({ "query": "周报" }));
        let result = msgs[2]["content"].as_array().unwrap()[0].clone();
        assert_eq!(result["type"], json!("tool_result"));
        assert_eq!(result["tool_use_id"], json!("toolu_1"));
        assert_eq!(result["content"], json!("找到 3 篇"));
        assert_eq!(
            body["tools"][0]["input_schema"],
            json!({ "type": "object" })
        );
        assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
    }

    #[test]
    fn broken_tool_arguments_degrade_to_empty_object() {
        let mut assistant = msg("assistant", "");
        assistant.tool_calls = Some(vec![AiToolCall {
            id: "c1".to_string(),
            name: "apply_edit".to_string(),
            arguments: "{ 不是 JSON".to_string(),
        }]);
        let (_, body) = chat(
            &cfg("anthropic", "https://api.anthropic.com"),
            Protocol::Anthropic,
            vec![assistant],
            None,
            true,
        );
        assert_eq!(body["messages"][0]["content"][0]["input"], json!({}));
        // 正文为空时不附带空的 text 块，只留 tool_use
        assert_eq!(body["messages"][0]["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn gemini_body_roles_schema_and_system_instruction() {
        let mut assistant = msg("assistant", "我看一下");
        assistant.tool_calls = Some(vec![AiToolCall {
            id: "c1".to_string(),
            name: "list_pages".to_string(),
            arguments: "{}".to_string(),
        }]);
        let (_, body) = chat(
            &cfg("gemini", "https://generativelanguage.googleapis.com/v1beta"),
            Protocol::Gemini,
            vec![
                msg("system", "协议"),
                msg("user", "列一下"),
                assistant,
                tool_msg("c1", "共 2 页"),
            ],
            Some(json!([
                { "type": "function", "function": {
                    "name": "list_pages",
                    "description": "列出页面",
                    "parameters": { "type": "object", "properties": { "limit": { "type": "integer" } } }
                } }
            ])),
            true,
        );
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], json!("协议"));
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents[0]["role"], json!("user"));
        assert_eq!(contents[1]["role"], json!("model"));
        // functionResponse 用工具名（Gemini 不认 id），从历史里的 tool_calls 反查
        assert_eq!(contents[2]["role"], json!("user"));
        assert_eq!(
            contents[2]["parts"][0]["functionResponse"]["name"],
            json!("list_pages")
        );
        assert_eq!(
            contents[2]["parts"][0]["functionResponse"]["response"]["result"],
            json!("共 2 页")
        );
        // schema 类型名大写才是 Gemini 认的枚举
        assert_eq!(
            body["tools"][0]["functionDeclarations"][0]["parameters"]["type"],
            json!("OBJECT")
        );
        assert_eq!(
            body["tools"][0]["functionDeclarations"][0]["parameters"]["properties"]["limit"]
                ["type"],
            json!("INTEGER")
        );
        assert_eq!(
            body["toolConfig"]["functionCallingConfig"]["mode"],
            json!("AUTO")
        );
    }

    #[test]
    fn anthropic_stream_frames_decode_into_unified_events() {
        let mut d = SseDecoder::new(Protocol::Anthropic);
        assert_eq!(
            d.decode(&line(
                r#"{"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}"#
            )),
            vec![SseParse::Usage(AiUsage {
                prompt_tokens: Some(11),
                completion_tokens: Some(1),
                total_tokens: Some(12),
            })]
        );
        assert_eq!(
            d.decode(&line(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#
            )),
            vec![SseParse::Delta("你好".to_string())]
        );
        assert_eq!(
            d.decode(&line(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想想"}}"#
            )),
            vec![SseParse::Reasoning("想想".to_string())]
        );
        assert_eq!(
            d.decode(&line(
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"query_database"}}"#
            )),
            vec![SseParse::ToolCallDelta {
                index: 1,
                id: Some("toolu_9".to_string()),
                name: Some("query_database".to_string()),
                args: String::new(),
            }]
        );
        assert_eq!(
            d.decode(&line(
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}"#
            )),
            vec![SseParse::ToolCallDelta {
                index: 1,
                id: None,
                name: None,
                args: r#"{"a":1}"#.to_string(),
            }]
        );
        // 与内容无关的帧（ping / block stop / 签名）安静跳过
        assert!(d
            .decode(&line(
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#
            ))
            .is_empty());
        assert!(d.decode("event: ping").is_empty());
        assert_eq!(
            d.decode(&line(r#"{"type":"message_stop"}"#)),
            vec![SseParse::Done]
        );
        assert_eq!(
            d.decode(&line(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
            )),
            vec![SseParse::Error("Overloaded".to_string())]
        );
        // 只有 output_tokens 的尾帧：总数按已知项留空，由合并方补
        assert_eq!(
            d.decode(&line(
                r#"{"type":"message_delta","usage":{"output_tokens":88}}"#
            )),
            vec![SseParse::Usage(AiUsage {
                prompt_tokens: None,
                completion_tokens: Some(88),
                total_tokens: None,
            })]
        );
    }

    #[test]
    fn images_inline_as_native_blocks_per_protocol() {
        let mut turn = msg("user", "这张图里有什么");
        turn.images = vec![image("aGk=", "image/png")];
        let turns = vec![turn];

        // OpenAI 兼容：content 变内容块，data URL 内联
        let (_, body) = chat(
            &cfg("openai", "https://api.deepseek.com"),
            Protocol::OpenAi,
            turns.clone(),
            None,
            true,
        );
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,aGk=" } })
        );
        assert!(body["messages"][0].get("images").is_none());

        // Anthropic：image 块自带 base64 source
        let (_, body) = chat(
            &cfg("anthropic", "https://api.anthropic.com"),
            Protocol::Anthropic,
            turns.clone(),
            None,
            true,
        );
        assert_eq!(
            body["messages"][0]["content"][0],
            json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } })
        );

        // Gemini：inlineData 部件
        let (_, body) = chat(
            &cfg("gemini", "https://generativelanguage.googleapis.com"),
            Protocol::Gemini,
            turns,
            None,
            true,
        );
        assert_eq!(
            body["contents"][0]["parts"][0],
            json!({ "inlineData": { "mimeType": "image/png", "data": "aGk=" } })
        );
    }

    #[test]
    fn gemini_stream_frames_decode_text_thought_and_calls() {
        let mut d = SseDecoder::new(Protocol::Gemini);
        // 一帧里正文与函数调用并存时，两个事件都要给出去
        let events = d.decode(&line(
            r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"正文"},{"functionCall":{"name":"list_pages","args":{"limit":3},"id":"fc_1"}}]},"finishReason":"STOP"}]}"#,
        ));
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0], SseParse::Delta("正文".to_string()));
        assert_eq!(
            events[1],
            SseParse::ToolCallDelta {
                index: 0,
                id: Some("fc_1".to_string()),
                name: Some("list_pages".to_string()),
                args: r#"{"limit":3}"#.to_string(),
            }
        );
        // 第二个调用换 index，前端才能把它们当成两次独立调用执行
        let events = d.decode(&line(
            r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_page_content","args":{"view_id":"v"}}}]}}]}"#,
        ));
        assert_eq!(
            events[0],
            SseParse::ToolCallDelta {
                index: 1,
                id: Some("call_get_page_content".to_string()),
                name: Some("get_page_content".to_string()),
                args: r#"{"view_id":"v"}"#.to_string(),
            }
        );
        // 深度思考部件与用量分别成事件
        assert_eq!(
            d.decode(&line(
                r#"{"candidates":[{"content":{"parts":[{"text":"推理","thought":true}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9}}"#
            )),
            vec![
                SseParse::Reasoning("推理".to_string()),
                SseParse::Usage(AiUsage {
                    prompt_tokens: Some(7),
                    completion_tokens: Some(2),
                    total_tokens: Some(9),
                })
            ]
        );
        assert_eq!(
            d.decode(&line(
                r#"{"error":{"code":401,"message":"API key not valid"}}"#
            )),
            vec![SseParse::Error("API key not valid".to_string())]
        );
    }

    #[test]
    fn openai_frames_still_use_the_existing_parser() {
        let mut d = SseDecoder::new(Protocol::OpenAi);
        // 空帧（Ignore）不再变成事件，省掉一次无谓的 match
        assert!(d.decode(": keep-alive").is_empty());
        assert_eq!(d.decode("data: [DONE]"), vec![SseParse::Done]);
    }

    #[test]
    fn empty_api_key_omits_auth_headers_but_keeps_protocol_headers() {
        let mut no_key = cfg("", "https://api.deepseek.com/v1");
        no_key.api_key = String::new();
        let (ep, _) = chat(&no_key, Protocol::OpenAi, vec![], None, true);
        assert!(ep.headers.is_empty(), "空 Key 不发空的 Bearer: {:?}", ep.headers);
        let ep = models(&no_key, Protocol::OpenAi);
        assert!(ep.headers.is_empty());

        let mut no_key = cfg("anthropic", "https://api.anthropic.com");
        no_key.api_key = "   ".to_string();
        let (ep, _) = chat(&no_key, Protocol::Anthropic, vec![], None, true);
        assert_eq!(
            ep.headers,
            vec![("anthropic-version".to_string(), "2023-06-01".to_string())],
            "anthropic-version 与凭据无关，必须保留"
        );

        let mut no_key = cfg("gemini", "https://generativelanguage.googleapis.com");
        no_key.api_key = String::new();
        let (ep, _) = chat(&no_key, Protocol::Gemini, vec![], None, true);
        assert!(ep.headers.is_empty());
        let ep = models(&no_key, Protocol::Gemini);
        assert!(ep.headers.is_empty());
    }

    #[test]
    fn thinking_off_sends_disable_params_where_defined() {
        let mut ai = cfg("anthropic", "https://api.anthropic.com");
        ai.thinking = "off".to_string();
        let (_, body) = chat(&ai, Protocol::Anthropic, vec![], None, true);
        assert_eq!(body["thinking"], json!({ "type": "disabled" }));

        let mut ai = cfg("gemini", "https://generativelanguage.googleapis.com");
        ai.thinking = "off".to_string();
        let (_, body) = chat(&ai, Protocol::Gemini, vec![], None, true);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"],
            json!({ "thinkingBudget": 0, "includeThoughts": false })
        );

        // auto（默认）：三家都不带思考参数
        let mut ai = cfg("anthropic", "https://api.anthropic.com");
        ai.thinking = "auto".to_string();
        let (_, body) = chat(&ai, Protocol::Anthropic, vec![], None, true);
        assert!(body.get("thinking").is_none());
        let mut ai = cfg("gemini", "https://generativelanguage.googleapis.com");
        ai.thinking = "auto".to_string();
        let (_, body) = chat(&ai, Protocol::Gemini, vec![], None, true);
        assert!(body["generationConfig"].get("thinkingConfig").is_none());

        // OpenAI 兼容：即使 off 也不下发（各家方言不一，见 openai_body 注释）
        let mut ai = cfg("openai", "https://api.deepseek.com/v1");
        ai.thinking = "off".to_string();
        let (_, body) = chat(&ai, Protocol::OpenAi, vec![], None, true);
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn non_streaming_responses_parse_per_protocol() {
        assert_eq!(
            completion_text(
                Protocol::Anthropic,
                r#"{"content":[{"type":"text","text":"pong"}]}"#
            )
            .unwrap(),
            "pong"
        );
        assert_eq!(
            completion_text(
                Protocol::Gemini,
                r#"{"candidates":[{"content":{"parts":[{"text":"po"},{"text":"ng"}]}}]}"#
            )
            .unwrap(),
            "pong"
        );
        // 200 但正文为空（tokens 全花在思考上）也算连通
        assert_eq!(
            completion_text(Protocol::Anthropic, r#"{"content":[]}"#).unwrap(),
            "模型已响应"
        );
        assert!(completion_text(Protocol::Gemini, r#"{"error":{"message":"bad key"}}"#).is_err());

        assert_eq!(
            model_ids(
                Protocol::Gemini,
                r#"{"models":[{"name":"models/gemini-2.5-flash"},{"name":"models/hidden"}]}"#
            ),
            vec!["gemini-2.5-flash".to_string(), "hidden".to_string()]
        );
        assert_eq!(
            model_ids(
                Protocol::Anthropic,
                r#"{"data":[{"id":"claude-sonnet-4"},{"id":"claude-haiku"}]}"#
            ),
            vec!["claude-haiku".to_string(), "claude-sonnet-4".to_string()]
        );
    }
}
