// 三家的请求体构造（OpenAI 兼容 / Anthropic / Gemini，从 ai_protocol/mod.rs 原样搬入，逻辑未改）。
// 共用的 Protocol、Endpoint、URL 与消息/工具辅助函数留在父模块，这里用 super::* 取。
use super::*;

// ---------- OpenAI 兼容 ----------

pub(super) fn openai_body(
    ai: &AiConfig,
    messages: &[AiMessage],
    tools: Option<Value>,
    stream: bool,
) -> Value {
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

pub(super) fn anthropic_body(
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

pub(super) fn gemini_body(ai: &AiConfig, messages: &[AiMessage], tools: Option<Value>) -> Value {
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
