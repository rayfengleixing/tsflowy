// ai_protocol 的用例（从 ai_protocol/mod.rs 原样搬入，断言未改）。
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
        body["tools"][0]["functionDeclarations"][0]["parameters"]["properties"]["limit"]["type"],
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
    assert!(
        ep.headers.is_empty(),
        "空 Key 不发空的 Bearer: {:?}",
        ep.headers
    );
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
