// AI 流式对话的传输层与各家协议的帧/错误解析（从 ai/mod.rs 原样搬入，逻辑未改）。
// 与配置域共用的类型、超时常量留在父模块，这里用 super::* 取。
use super::config::effective_ai;
use super::*;

/// 流式对话结果：控制流走 Rust 返回值，内容仍逐块推给前端 channel。
/// 载荷字段当前仅供单测断言，线上链路由 Done 事件送达前端。
#[derive(Debug, PartialEq, Eq)]
pub enum StreamOutcome {
    /// 正常结束：full 为正式回答，tool_calls 为累积出的函数调用
    Done {
        full: String,
        tool_calls: Vec<AiToolCall>,
    },
    /// 用户取消（世代过期）
    Cancelled,
    /// 已把错误发给前端
    Failed,
}

/// 流式对话：逐块通过 channel 推给前端。
/// 配置错误直接返回 Err；一旦进入流式阶段，任何失败都以 AiEvent::Error 通知前端。
/// agent 多步循环在前端编排：本命令一次请求一进一出，把 tool_calls 完整回传供前端执行工具。
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
    inline_images(&app, &mut messages)?;
    let custom = ai.system_prompt.trim();
    if !custom.is_empty() {
        messages.push(AiMessage {
            role: "system".to_string(),
            content: custom.to_string(),
            tool_calls: None,
            tool_call_id: None,
            images: Vec::new(),
        });
    }
    match stream_once(&client, &ai, messages, req.tools, generation, &on_event).await {
        StreamOutcome::Done { .. } | StreamOutcome::Cancelled | StreamOutcome::Failed => Ok(()),
    }
}

/// 单次流式请求：构造 body → 流前重试 → 逐帧解析推送。
/// 结束（[DONE] 或断流）时经 channel 发出 Done 事件并携带累积的 tool_calls。
async fn stream_once(
    client: &reqwest::Client,
    ai: &AiConfig,
    messages: Vec<AiMessage>,
    tools: Option<serde_json::Value>,
    generation: u64,
    on_event: &Channel<AiEvent>,
) -> StreamOutcome {
    // 协议差异（地址、鉴权头、请求体形态）全部收在 ai_protocol，这里只负责传输与取消
    let protocol = ai_protocol::Protocol::resolve(&ai.protocol, &ai.base_url);
    let (endpoint, body) = ai_protocol::chat(ai, protocol, messages, tools, true);
    // 流开始前允许重试：建连失败 / 429 / 5xx 各退避再试，次数由配置（网络慢的服务商可以调大）。
    // 进入流式阶段后绝不重试——内容可能已经吐给前端，重试会造成重复输出。
    let retries = ai.stream_retries.min(5);
    let resp = {
        let mut attempt: u32 = 0;
        loop {
            if cancelled(generation) {
                send_cancelled(on_event);
                return StreamOutcome::Cancelled;
            }
            let sent = endpoint
                .apply(client.post(&endpoint.url))
                .json(&body)
                .send()
                .await;
            match sent {
                Err(e) => {
                    if attempt < retries && !cancelled(generation) {
                        tokio::time::sleep(backoff(attempt)).await;
                        attempt += 1;
                        continue;
                    }
                    let _ = on_event.send(AiEvent::Error {
                        message: format!("连接失败：{e}"),
                        code: Some("network".to_string()),
                    });
                    return StreamOutcome::Failed;
                }
                Ok(r) => {
                    let status = r.status();
                    if status.is_success() {
                        break r;
                    }
                    // 429 优先尊重服务端的 Retry-After，其余按固定退避；读正文前取头
                    let wait = if retryable_status(status) {
                        retry_after(&r, backoff(attempt))
                    } else {
                        Duration::ZERO
                    };
                    if attempt < retries && retryable_status(status) && !cancelled(generation) {
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
                    return StreamOutcome::Failed;
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
    // 函数调用增量按 index 归并（多工具并行调用时每个调用各有 index）：(id, name, arguments)
    let mut tool_deltas: std::collections::BTreeMap<u32, (String, String, String)> =
        Default::default();
    let mut usage: Option<AiUsage> = None;
    let mut decoder = ai_protocol::SseDecoder::new(protocol);
    // 首帧用较短的等待上限，之后放宽：推理型模型会先长时间吐 reasoning，期间帧是连续的。
    let mut awaiting_first = true;

    loop {
        let wait = if awaiting_first {
            first_chunk_timeout(ai)
        } else {
            idle_chunk_timeout(ai)
        };
        // 没有总超时（长回答可能持续数分钟），但任何一段「静默」都必须在上限内出新帧，
        // 否则视为网络假死，主动报错而不是让用户面对一个永远转圈的界面。
        let item = match timeout(wait, stream.next()).await {
            Ok(Some(item)) => item,
            Ok(None) => break,
            Err(_) => {
                // 文案里的秒数取实际生效值：让用户自己调过之后还报「30 秒」会误导排查
                let message = if awaiting_first {
                    format!(
                        "等待模型首个响应超时（{} 秒），可在设置里调大首帧等待，或检查网络与服务商状态",
                        wait.as_secs()
                    )
                } else {
                    format!("模型响应中断超过 {} 秒，已停止等待", wait.as_secs())
                };
                let _ = on_event.send(AiEvent::Error {
                    message: message.to_string(),
                    code: Some("timeout".to_string()),
                });
                return StreamOutcome::Failed;
            }
        };
        if cancelled(generation) {
            send_cancelled(on_event);
            return StreamOutcome::Cancelled;
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
                return StreamOutcome::Failed;
            }
        }
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            // 去掉行尾的 '\n'
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            // 一帧里可能同时给出正文增量与函数调用（Gemini 尤其如此），逐个事件处理
            for event in decoder.decode(&line) {
                match event {
                    SseParse::Delta(delta) => {
                        if cancelled(generation) {
                            send_cancelled(on_event);
                            return StreamOutcome::Cancelled;
                        }
                        full.push_str(&delta);
                        if on_event.send(AiEvent::Chunk { delta }).is_err() {
                            return StreamOutcome::Failed;
                        }
                    }
                    SseParse::Reasoning(delta) => {
                        if cancelled(generation) {
                            send_cancelled(on_event);
                            return StreamOutcome::Cancelled;
                        }
                        // 思考内容不计入 full：Done 回传的仍只是正式回答
                        if on_event.send(AiEvent::Reasoning { delta }).is_err() {
                            return StreamOutcome::Failed;
                        }
                    }
                    SseParse::Error(message) => {
                        // 流里报的错拿不到状态码，按关键字猜一个归类
                        let code = guess_error_code(&message);
                        let _ = on_event.send(AiEvent::Error {
                            message,
                            code: Some(code.to_string()),
                        });
                        return StreamOutcome::Failed;
                    }
                    SseParse::Usage(u) => {
                        usage = Some(match usage.take() {
                            Some(old) => old.merged_with(u),
                            None => u,
                        });
                    }
                    SseParse::ToolCallDelta {
                        index,
                        id,
                        name,
                        args,
                    } => {
                        let entry = tool_deltas
                            .entry(index)
                            .or_insert_with(|| (String::new(), String::new(), String::new()));
                        if let Some(v) = id {
                            if !v.is_empty() {
                                entry.0 = v;
                            }
                        }
                        if let Some(v) = name {
                            if !v.is_empty() {
                                entry.1 = v;
                            }
                        }
                        entry.2.push_str(&args);
                    }
                    SseParse::Done => {
                        let tool_calls = collect_tool_calls(tool_deltas);
                        let _ = on_event.send(AiEvent::Done {
                            full: full.clone(),
                            usage,
                            tool_calls: tool_calls.clone(),
                        });
                        return StreamOutcome::Done { full, tool_calls };
                    }
                    // 解码器已过滤掉与内容无关的帧
                    _ => {}
                }
            }
        }
    }
    // 服务端未发 [DONE] 就断流：按正常结束处理，把已收到的内容交给前端
    let tool_calls = collect_tool_calls(tool_deltas);
    let _ = on_event.send(AiEvent::Done {
        full: full.clone(),
        usage,
        tool_calls: tool_calls.clone(),
    });
    StreamOutcome::Done { full, tool_calls }
}

fn send_cancelled(on_event: &Channel<AiEvent>) {
    let _ = on_event.send(AiEvent::Error {
        message: "cancelled".to_string(),
        code: Some("cancelled".to_string()),
    });
}

/// 把按 index 归并的 (id, name, arguments) 增量转成完整的函数调用列表。
/// 无名无参的帧（纯 index 占位）丢弃；缺 id 时补一个占位，保证前端回灌时能配对 tool 消息。
pub(super) fn collect_tool_calls(
    deltas: std::collections::BTreeMap<u32, (String, String, String)>,
) -> Vec<AiToolCall> {
    deltas
        .into_values()
        .filter(|(_, name, args)| !name.is_empty() || !args.trim().is_empty())
        .map(|(id, name, args)| AiToolCall {
            id: if id.is_empty() {
                format!("call_{name}")
            } else {
                id
            },
            name,
            arguments: args,
        })
        .collect()
}

// ---------- 纯函数（便于离线单测） ----------

fn cancelled(generation: u64) -> bool {
    AI_GENERATION.load(Ordering::SeqCst) != generation
}

/// 从 `{"error": ...}` 里提取可读信息（error 可能是对象或字符串）
pub(crate) fn extract_error_message(v: &serde_json::Value) -> Option<String> {
    let err = v.get("error")?;
    if let Some(s) = err.as_str() {
        return Some(s.to_string());
    }
    err.get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SseParse {
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
    /// 函数调用增量帧：按 index 归并 id/name/arguments
    ToolCallDelta {
        index: u32,
        id: Option<String>,
        name: Option<String>,
        args: String,
    },
    /// 非 data 行，或空 delta
    Ignore,
}

/// 解析单行 SSE：按 `data:` 前缀取值，`[DONE]` 结束，取 `choices[0].delta.content`；
/// content 为空时回退到 `choices[0].delta.reasoning_content`（推理型模型）。
/// 一行可能同时携带多个事件（正文 + 多个并行函数调用 + 用量），全部按序返回；
/// 只取第一个 tool_call 会把并行工具调用的后续增量整帧丢掉，回灌给模型的调用列表缺项。
pub(crate) fn parse_sse_line(line: &str) -> Vec<SseParse> {
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
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Vec::new();
    };
    if let Some(msg) = extract_error_message(&v) {
        return vec![SseParse::Error(msg)];
    }
    let mut out = Vec::new();
    let delta = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"));
    let content = delta
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if !content.is_empty() {
        out.push(SseParse::Delta(content.to_string()));
    } else {
        let reasoning = delta
            .and_then(|d| d.get("reasoning_content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        if !reasoning.is_empty() {
            out.push(SseParse::Reasoning(reasoning.to_string()));
        }
    }
    // 函数调用增量：首个调用带 name，后续调用各自带 index；参数分多帧到达。
    // 一帧内可能出现多个并行调用条目，逐条翻译、一条都不能漏。
    if let Some(calls) = delta
        .and_then(|d| d.get("tool_calls"))
        .and_then(|c| c.as_array())
    {
        for first in calls {
            let index = first.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
            let id = first
                .get("id")
                .and_then(|i| i.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let function = first.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let args = function
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .unwrap_or("");
            if id.is_some() || name.is_some() || !args.is_empty() {
                out.push(SseParse::ToolCallDelta {
                    index,
                    id,
                    name,
                    args: args.to_string(),
                });
            }
        }
    }
    // 内容帧走完了才看用量：部分服务商（含带 null usage 的流式实现）会在每一帧都带上 usage 字段，
    // 先判用量会把正常内容帧当成空帧丢掉。只有拿到了完整用量才算一条 Usage 事件。
    if let Some(u) = v.get("usage") {
        let usage = AiUsage {
            prompt_tokens: u
                .get("prompt_tokens")
                .and_then(|x| x.as_u64())
                .map(|x| x as u32),
            completion_tokens: u
                .get("completion_tokens")
                .and_then(|x| x.as_u64())
                .map(|x| x as u32),
            total_tokens: u
                .get("total_tokens")
                .and_then(|x| x.as_u64())
                .map(|x| x as u32),
        };
        if usage.is_meaningful() {
            out.push(SseParse::Usage(usage));
        }
    }
    out
}

/// 值得在流开始前重试的状态码：限流与服务商侧故障通常是瞬时的
pub(super) fn retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

/// 429 优先尊重服务端的 Retry-After（秒），夹在 0.2–10 秒之间；解析不出来用固定退避
pub(super) fn parse_retry_after(value: Option<&str>, fallback: Duration) -> Duration {
    value
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| {
            Duration::from_secs(secs).clamp(Duration::from_millis(200), Duration::from_secs(10))
        })
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
pub(super) fn error_code(status: u16, payload: &str) -> &'static str {
    match status {
        401 | 403 => "auth",
        429 => "rate_limit",
        402 => "quota",
        _ => {
            let lower = payload.to_lowercase();
            // 上下文超长各家都回 400，混在 request 里会误导用户去查模型名，先单独认出来
            if is_context_length_error(&lower) {
                "context_length"
            } else if lower.contains("insufficient")
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

/// 上下文超长的识别：状态码帮不上忙（400 是通用「请求有问题」），只能认服务端文案。
/// 传进来的字符串须已小写；中文关键字原样匹配。
fn is_context_length_error(lower: &str) -> bool {
    const PHRASES: [&str; 6] = [
        "context_length_exceeded",
        "context length",
        "context window",
        "prompt is too long",
        "too many tokens",
        "input is too long",
    ];
    PHRASES.iter().any(|p| lower.contains(p))
        || (lower.contains("上下文")
            && (lower.contains("超出") || lower.contains("超过") || lower.contains("过长")))
}

/// 流开始之后才报出的错误拿不到状态码，只能从文本里猜归类
pub(super) fn guess_error_code(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthor")
        || lower.contains("invalid api key")
    {
        "auth"
    } else if lower.contains("429") || lower.contains("rate limit") || lower.contains("rate_limit")
    {
        "rate_limit"
    } else if is_context_length_error(&lower) {
        "context_length"
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
pub(super) fn readable_http_error(status: u16, body: &str) -> String {
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
pub(crate) fn parse_completion_text(body: &str) -> Result<String, String> {
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

/// 把消息里的图片附件（assets/ 相对路径）读成 base64，供各家协议内联下发。
/// 读不出来的图一律报错而不是静默跳过：用户明确附了图，「模型没看到图」比请求失败更难解释。
pub(crate) fn inline_images(
    app: &tauri::AppHandle,
    messages: &mut [AiMessage],
) -> Result<(), String> {
    for m in messages.iter_mut().filter(|m| !m.images.is_empty()) {
        if m.images.len() > MAX_IMAGES_PER_MESSAGE {
            return Err(format!("一条消息最多附 {MAX_IMAGES_PER_MESSAGE} 张图片"));
        }
        for img in &mut m.images {
            let media_type = image_media_type(&img.path)
                .ok_or_else(|| format!("不支持的图片格式：{}", img.path))?;
            let bytes = super::files::asset::load_asset_bytes(app, &img.path)?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(format!(
                    "图片太大（{} MB），单张上限 {} MB",
                    bytes.len() / 1024 / 1024,
                    MAX_IMAGE_BYTES / 1024 / 1024
                ));
            }
            img.media_type = media_type.to_string();
            img.data = BASE64.encode(&bytes);
        }
    }
    Ok(())
}

/// 按扩展名给出 MIME；只认各家视觉模型都支持的四种格式
pub(super) fn image_media_type(path: &str) -> Option<&'static str> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// 只设 connect_timeout（约 15s），不设全局总超时：流式响应可能持续很久
pub(super) fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))
}
