// 非流式响应解析（连通性测试 / 模型列表）与 SSE 帧解码（从 ai_protocol/mod.rs 原样搬入，逻辑未改）。
// 共用的类型与辅助函数留在父模块，这里用 super::* 取。
use super::*;

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
