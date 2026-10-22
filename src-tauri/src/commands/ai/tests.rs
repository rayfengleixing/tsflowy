// ai 的用例（从 ai/mod.rs 原样搬入，断言未改）。
use super::chat::{
    collect_tool_calls, error_code, guess_error_code, image_media_type, parse_retry_after,
    retryable_status,
};
use super::config::{apply_profile, mask_api_key, request_ready};
use super::*;

/// 一份只关心网络调参的输入：其余字段取「够用就行」的值
fn tuning_input(json: &str) -> AiConfigInput {
    let full = format!(
        r#"{{"enabled":true,"provider":"custom","protocol":"","base_url":"https://api.example.com",
               "model":"m","max_chars":8000,"confirm_edit":true,"temperature":0.7,"max_tokens":0,
               "system_prompt":"","profiles":[],"active_profile":"","quick_actions":[],"use_tools":false,{json}}}"#
    );
    serde_json::from_str(&full).expect("测试用的配置 JSON 应能解析")
}

#[test]
fn runtime_tuning_falls_back_to_defaults_on_zero_and_clamps_extremes() {
    // 全 0：除 stream_retries 之外都回落默认值（老配置 JSON 里根本没有这几项，走 serde 默认）
    let cfg = tuning_input(
        r#""agent_rounds":0,"first_byte_timeout":0,"idle_timeout":0,"stream_retries":0"#,
    );
    let mut ai = AiConfig::default();
    normalize_runtime_tuning(&cfg, &mut ai);
    assert_eq!(ai.agent_rounds, files::AI_AGENT_ROUNDS_DEFAULT);
    assert_eq!(ai.first_byte_timeout, files::AI_FIRST_BYTE_TIMEOUT_DEFAULT);
    assert_eq!(ai.idle_timeout, files::AI_IDLE_TIMEOUT_DEFAULT);
    // 重试次数上的 0 是用户明确表达「别重试」，不能被当成「未设置」又变回 2
    assert_eq!(ai.stream_retries, 0);

    // 极端值夹住：填 99999 秒不该让界面永远转圈，填 12 轮以上只是烧钱
    let big = tuning_input(
        r#""agent_rounds":99,"first_byte_timeout":99999,"idle_timeout":99999,"stream_retries":99"#,
    );
    let mut ai2 = AiConfig::default();
    normalize_runtime_tuning(&big, &mut ai2);
    assert_eq!(ai2.agent_rounds, 12);
    assert_eq!(ai2.first_byte_timeout, 600);
    assert_eq!(ai2.idle_timeout, 1800);
    assert_eq!(ai2.stream_retries, 5);

    // 本地模型冷启动要 90 秒：这类值原样保留
    let slow = tuning_input(
        r#""agent_rounds":8,"first_byte_timeout":90,"idle_timeout":300,"stream_retries":4"#,
    );
    let mut ai3 = AiConfig::default();
    normalize_runtime_tuning(&slow, &mut ai3);
    assert_eq!(
        (
            ai3.agent_rounds,
            ai3.first_byte_timeout,
            ai3.idle_timeout,
            ai3.stream_retries
        ),
        (8, 90, 300, 4)
    );
}

#[test]
fn image_media_type_recognizes_supported_extensions() {
    assert_eq!(image_media_type("assets/1.PNG"), Some("image/png"));
    assert_eq!(image_media_type("assets/1.jpeg"), Some("image/jpeg"));
    assert_eq!(image_media_type("assets/1.webp"), Some("image/webp"));
    // bmp / svg 各家视觉模型支持参差，一律不收
    assert_eq!(image_media_type("assets/1.bmp"), None);
    assert_eq!(image_media_type("assets/no-extension"), None);
}

#[test]
fn message_deserializes_with_image_paths_only() {
    // 前端只给 assets/ 相对路径；media_type 与 data 由发请求前内联时补上
    let m: AiMessage = serde_json::from_str(
        r#"{"role":"user","content":"看图","images":[{"path":"assets/1.png"}]}"#,
    )
    .unwrap();
    assert_eq!(m.images.len(), 1);
    assert_eq!(m.images[0].path, "assets/1.png");
    assert!(m.images[0].data.is_empty());
    // 老版本前端不带 images 字段同样能解析
    let old: AiMessage = serde_json::from_str(r#"{"role":"user","content":"你好"}"#).unwrap();
    assert!(old.images.is_empty());
}

#[test]
fn parse_sse_single_delta_line() {
    let line = r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::Delta("你好".to_string())]
    );
}

#[test]
fn parse_sse_reasoning_line() {
    // 推理型模型：content 为空、reasoning_content 有内容 → 归为 Reasoning
    let line = r#"data: {"choices":[{"delta":{"content":"","reasoning_content":"思考中"}}]}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::Reasoning("思考中".to_string())]
    );
    // 两者都有时 content 优先
    let line = r#"data: {"choices":[{"delta":{"content":"答案","reasoning_content":"思考"}}]}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::Delta("答案".to_string())]
    );
}

#[test]
fn parse_sse_multiline_block() {
    let text = r#"data: {"choices":[{"delta":{"content":"a"}}]}

data: {"choices":[{"delta":{"content":"b"}}]}

data: [DONE]
"#;
    // 空行/非 data 行不产生事件；保留有效事件
    let meaningful: Vec<SseParse> = text
        .lines()
        .flat_map(parse_sse_line)
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
    assert_eq!(parse_sse_line("data: [DONE]"), vec![SseParse::Done]);
    assert_eq!(parse_sse_line("data:[DONE]"), vec![SseParse::Done]);
    assert!(parse_sse_line(": keep-alive").is_empty());
    assert!(parse_sse_line("event: message").is_empty());
    // 有 choices 但 delta 为空（如首帧/尾帧）：忽略
    assert!(parse_sse_line(r#"data: {"choices":[{"delta":{}}]}"#).is_empty());
}

#[test]
fn parse_sse_usage_frame() {
    let line = r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::Usage(AiUsage {
            prompt_tokens: Some(12),
            completion_tokens: Some(34),
            total_tokens: Some(46),
        })]
    );
}

#[test]
fn parse_sse_tool_call_deltas() {
    // 首帧：带 id 与 name
    let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_workspace","arguments":""}}]}}]}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::ToolCallDelta {
            index: 0,
            id: Some("call_1".to_string()),
            name: Some("search_workspace".to_string()),
            args: String::new(),
        }]
    );
    // 后续帧：只有参数增量
    let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            args: "{\"query\":".to_string(),
        }]
    );
    // 并行多调用同帧到达：每一个条目都要翻译出来（旧实现只取 first，后续整帧丢弃）
    let line = r#"data: {"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_a","function":{"name":"search_workspace","arguments":"{}"}},
            {"index":1,"id":"call_b","function":{"name":"list_pages","arguments":"{}"}}
        ]}}]}"#;
    let events = parse_sse_line(line);
    assert_eq!(events.len(), 2, "同一帧两个并行调用都必须产出: {events:?}");
    assert_eq!(
        events[0],
        SseParse::ToolCallDelta {
            index: 0,
            id: Some("call_a".to_string()),
            name: Some("search_workspace".to_string()),
            args: "{}".to_string(),
        }
    );
    assert_eq!(
        events[1],
        SseParse::ToolCallDelta {
            index: 1,
            id: Some("call_b".to_string()),
            name: Some("list_pages".to_string()),
            args: "{}".to_string(),
        }
    );
    // 正文与工具调用同帧：两个事件都在
    let line = r#"data: {"choices":[{"delta":{"content":"先查一下","tool_calls":[{"index":0,"id":"c1","function":{"name":"list_pages","arguments":"{}"}}]}}]}"#;
    let events = parse_sse_line(line);
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0], SseParse::Delta("先查一下".to_string()));
    // 空壳帧（只有 index）忽略
    let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}"#;
    assert!(parse_sse_line(line).is_empty());
}

#[test]
fn collect_tool_calls_merges_by_index() {
    let mut deltas = std::collections::BTreeMap::new();
    deltas.insert(
        0u32,
        (
            "call_a".to_string(),
            "search_workspace".to_string(),
            String::new(),
        ),
    );
    deltas.get_mut(&0).unwrap().2.push_str(r#"{"query":"x"}"#);
    // 第二个调用：只有参数与 name，没有 id → 补占位 id
    deltas.insert(
        1u32,
        (String::new(), "list_pages".to_string(), "{}".to_string()),
    );
    // 无名无参的占位条目丢弃
    deltas.insert(2u32, (String::new(), String::new(), "  ".to_string()));
    let calls = collect_tool_calls(deltas);
    assert_eq!(
        calls,
        vec![
            AiToolCall {
                id: "call_a".to_string(),
                name: "search_workspace".to_string(),
                arguments: r#"{"query":"x"}"#.to_string(),
            },
            AiToolCall {
                id: "call_list_pages".to_string(),
                name: "list_pages".to_string(),
                arguments: "{}".to_string(),
            },
        ]
    );
}

#[test]
fn parse_sse_null_usage_is_ignored() {
    // 每帧都带 usage:null 的服务商：不能把内容帧吞掉，也不产生用量事件
    let line = r#"data: {"choices":[{"delta":{"content":"好"}}],"usage":null}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::Delta("好".to_string())]
    );
    assert!(parse_sse_line(r#"data: {"choices":[],"usage":null}"#).is_empty());
}

#[test]
fn parse_sse_error_payload() {
    let line = r#"data: {"error":{"message":"invalid api key","type":"auth"}}"#;
    assert_eq!(
        parse_sse_line(line),
        vec![SseParse::Error("invalid api key".to_string())]
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
    let cfg: files::AppConfig = serde_json::from_str(r#"{"custom_data_dir":"D:/data"}"#).unwrap();
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
fn parse_completion_text_reads_message_content() {
    let body = r#"{"choices":[{"message":{"role":"assistant","content":"pong"}}]}"#;
    assert_eq!(parse_completion_text(body).unwrap(), "pong");
    assert!(parse_completion_text(r#"{"error":{"message":"nope"}}"#).is_err());
    // 推理型模型：max_tokens 全用在思考上，content 为空但仍算连通
    let body = r#"{"choices":[{"message":{"content":"","reasoning_content":"We need answer"}}]}"#;
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

#[test]
fn request_ready_allows_empty_api_key() {
    let mut ai = AiConfig::default();
    assert!(!request_ready(&ai));
    ai.base_url = "http://localhost:11434".to_string();
    assert!(!request_ready(&ai), "缺模型名仍未就绪");
    ai.model = "qwen2.5".to_string();
    assert!(request_ready(&ai), "本地模型无 Key 也应就绪");
    ai.api_key = "  ".to_string();
    assert!(request_ready(&ai), "空白 Key 等同于无 Key，不影响就绪");
    // Base URL 空白 → 未就绪
    ai.base_url = " ".to_string();
    assert!(!request_ready(&ai));
}

#[test]
fn apply_profile_overrides_only_nonempty_fields() {
    let mut ai = AiConfig {
        enabled: true,
        protocol: "openai".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        model: "deepseek-chat".to_string(),
        api_key: "global-key".to_string(),
        temperature: 1.0,
        ..Default::default()
    };
    // 本地档位：自带协议与地址，但无 Key（继承全局 Key）
    let p = files::AiProfile {
        id: "local".to_string(),
        name: "本地".to_string(),
        base_url: "http://localhost:11434/v1".to_string(),
        model: "qwen2.5".to_string(),
        temperature: 0.3,
        protocol: String::new(),
        api_key: String::new(),
    };
    apply_profile(&mut ai, &p, "");
    assert_eq!(ai.base_url, "http://localhost:11434/v1");
    assert_eq!(ai.model, "qwen2.5");
    assert_eq!(ai.temperature, 0.3);
    assert_eq!(ai.protocol, "openai", "空协议应继承全局");
    assert_eq!(ai.api_key, "global-key", "空 Key 应继承全局");

    // 档位显式指定协议与 Key 时优先
    let p2 = files::AiProfile {
        protocol: "anthropic".to_string(),
        ..p
    };
    apply_profile(&mut ai, &p2, "profile-key");
    assert_eq!(ai.protocol, "anthropic");
    assert_eq!(ai.api_key, "profile-key");
    // 生效 Key 为空时回到继承（此时全局 Key 已被上一行覆盖为档位 Key）
    let mut ai2 = AiConfig {
        api_key: "global-key".to_string(),
        ..Default::default()
    };
    apply_profile(&mut ai2, &p2, "   ");
    assert_eq!(ai2.api_key, "global-key");
}

#[test]
fn profile_input_without_api_key_keeps_old_value() {
    // AiProfileInput.api_key 缺省（None）时 serde 反序列化应为 None 而非报错
    let input: AiProfileInput =
        serde_json::from_str(r#"{"id":"a","name":"A","base_url":"","model":"","temperature":0.7}"#)
            .unwrap();
    assert!(input.api_key.is_none());
    assert_eq!(input.protocol, "");
    // Some("") 表示清空
    let input: AiProfileInput = serde_json::from_str(
            r#"{"id":"a","name":"A","base_url":"","model":"","temperature":0.7,"api_key":"","protocol":"Gemini"}"#,
        )
        .unwrap();
    assert_eq!(input.api_key.as_deref(), Some(""));
    assert_eq!(input.protocol, "Gemini");
}

#[test]
fn old_config_without_new_ai_fields_deserializes() {
    // 升级前写出的 config.json：ai 段没有 thinking / ctx_* / 档位 protocol+api_key
    let cfg: files::AppConfig = serde_json::from_str(
            r#"{"ai":{"enabled":true,"provider":"","base_url":"u","model":"m","api_key":"k","max_chars":8000,"confirm_edit":true,"profiles":[{"id":"p1","name":"P","base_url":"","model":"m2","temperature":0.5}]}}"#,
        )
        .unwrap();
    let ai = cfg.ai.unwrap();
    assert_eq!(ai.thinking, "auto");
    assert_eq!(ai.ctx_token_budget, files::AI_CTX_TOKEN_BUDGET_DEFAULT);
    assert_eq!(ai.ctx_max_messages, files::AI_CTX_MAX_MESSAGES_DEFAULT);
    assert_eq!(ai.ctx_scope, "full");
    let p = &ai.profiles[0];
    assert_eq!(p.protocol, "");
    assert_eq!(p.api_key, "");
}

#[test]
fn ctx_scope_falls_back_to_full_on_any_unknown_value() {
    assert_eq!(normalize_ctx_scope("page_only"), "page_only");
    assert_eq!(normalize_ctx_scope("OFF"), "off");
    // 脏值不能变成「什么都不带」：默认行为是少带而不是漏带上下文
    assert_eq!(normalize_ctx_scope(""), "full");
    assert_eq!(normalize_ctx_scope("everything"), "full");
}

#[test]
fn context_length_400_is_not_classified_as_a_bad_request() {
    // OpenAI / Anthropic / 中文网关三种写法都要认出 context_length
    assert_eq!(
        error_code(
            400,
            r#"{"error":{"code":"context_length_exceeded","message":"This model's maximum context length is 8192 tokens"}}"#
        ),
        "context_length"
    );
    assert_eq!(
        error_code(400, "prompt is too long: 254000 tokens > 200000 maximum"),
        "context_length"
    );
    assert_eq!(
        error_code(400, "输入长度已超出上下文范围"),
        "context_length"
    );
    // 其它 400 仍归 request，别把上下文判定扩得太宽
    assert_eq!(
        error_code(400, r#"{"error":{"message":"Invalid model name"}}"#),
        "request"
    );
    assert_eq!(
        error_code(400, "temperature must be between 0 and 2"),
        "request"
    );
}

#[test]
fn quota_and_context_length_keep_separate_codes() {
    assert_eq!(error_code(400, "Insufficient balance"), "quota");
    assert_eq!(error_code(429, "too many tokens per minute"), "rate_limit");
    assert_eq!(error_code(503, "upstream unavailable"), "server");
    // 流内报错没有状态码，同样要认出超长
    assert_eq!(
        guess_error_code("This model's context window is 32768 tokens"),
        "context_length"
    );
}
