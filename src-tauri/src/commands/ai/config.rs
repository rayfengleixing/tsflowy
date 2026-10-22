// AI 配置的读写命令与「生效配置」解析（从 ai/mod.rs 原样搬入，逻辑未改）。
// 与流式对话共用的类型、超时常量留在父模块，这里用 super::* 取。
use super::chat::{build_client, readable_http_error};
use super::*;

/// 读取 AI 配置（掩码返回，不泄露 key）
#[tauri::command]
pub fn ai_get_config(app: tauri::AppHandle) -> Result<AiConfigPublic, String> {
    let cfg = files::load_app_config(&app);
    let (key, plaintext) = effective_api_key(&app);
    Ok(public_of(&app, &cfg, &key, plaintext))
}

/// 保存 AI 配置
#[tauri::command]
pub fn ai_save_config(app: tauri::AppHandle, cfg: AiConfigInput) -> Result<(), String> {
    let mut app_cfg = files::load_app_config(&app);
    let mut ai = app_cfg.ai.take().unwrap_or_default();
    // 先归一网络与 agent 调参：下面开始逐字段搬移 cfg（部分移动之后就再也借不到完整的 cfg 了）
    normalize_runtime_tuning(&cfg, &mut ai);
    ai.enabled = cfg.enabled;
    ai.provider = cfg.provider;
    // 归一小写存着，识别时少一次比较；空串就是「自动」
    ai.protocol = cfg.protocol.trim().to_ascii_lowercase();
    ai.base_url = cfg.base_url;
    ai.model = cfg.model;
    ai.max_chars = cfg.max_chars;
    ai.confirm_edit = cfg.confirm_edit;
    ai.temperature = cfg.temperature.clamp(0.0, 2.0);
    ai.thinking = if cfg.thinking.eq_ignore_ascii_case("off") {
        "off".to_string()
    } else {
        "auto".to_string()
    };
    // 0 视为「未设置」回落默认值，其余夹到安全范围（输入框可能被填成极端值）
    ai.ctx_token_budget = if cfg.ctx_token_budget == 0 {
        files::AI_CTX_TOKEN_BUDGET_DEFAULT
    } else {
        cfg.ctx_token_budget.clamp(100, 200_000)
    };
    ai.ctx_max_messages = if cfg.ctx_max_messages == 0 {
        files::AI_CTX_MAX_MESSAGES_DEFAULT
    } else {
        cfg.ctx_max_messages.clamp(1, 500)
    };
    // 上下文范围只认三档，脏值一律回落 full：这是「少带上下文」的开关，宁可退回默认行为
    ai.ctx_scope = normalize_ctx_scope(&cfg.ctx_scope).to_string();
    ai.max_tokens = cfg.max_tokens;
    ai.system_prompt = cfg.system_prompt;
    // 档位 Key 是逐档密文：入参 api_key=None 表示「不改该档 Key」，按 id 从旧配置带回。
    // 非空 Key 写进系统凭据库（账户名按档位 id 区分，一档一条）：写入成功则 config.json 不留明文，
    // 失败则回退明文保证可用；Some("") 表示清空该档 Key（改为继承全局）。
    let old_profiles = std::mem::take(&mut ai.profiles);
    ai.profiles = cfg
        .profiles
        .into_iter()
        .map(|p| {
            let api_key = match p.api_key {
                None => old_profiles
                    .iter()
                    .find(|o| o.id == p.id)
                    .map(|o| o.api_key.clone())
                    .unwrap_or_default(),
                Some(key) => {
                    let key = key.trim().to_string();
                    let account = secret::profile_account(&p.id);
                    if key.is_empty() {
                        secret::delete_key_for(&account);
                        String::new()
                    } else if secret::store_key_for(&account, &key) {
                        String::new()
                    } else {
                        key
                    }
                }
            };
            files::AiProfile {
                id: p.id,
                name: p.name,
                base_url: p.base_url,
                model: p.model,
                temperature: p.temperature.clamp(0.0, 2.0),
                protocol: p.protocol.trim().to_ascii_lowercase(),
                api_key,
            }
        })
        .collect();
    // 被删掉的档位：连带清掉它在凭据库里的 Key，避免留下无主密文
    for old in &old_profiles {
        if !ai.profiles.iter().any(|p| p.id == old.id) {
            secret::delete_key_for(&secret::profile_account(&old.id));
        }
    }
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
    // 单价不接受负数：前端输入框可能被填成负值，估算口径统一在这里夹一次
    ai.price_input = cfg.price_input.max(0.0);
    ai.price_output = cfg.price_output.max(0.0);
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
    let protocol = ai_protocol::Protocol::resolve(&ai.protocol, &ai.base_url);
    // 探活只要「服务端受理了请求」，给一个足够小的 token 上限，别让它真写一段话
    let mut probe = ai.clone();
    probe.max_tokens = if probe.max_tokens > 0 {
        probe.max_tokens.min(64)
    } else {
        64
    };
    let ping = vec![AiMessage {
        role: "user".to_string(),
        content: "ping".to_string(),
        tool_calls: None,
        tool_call_id: None,
        images: Vec::new(),
    }];
    let (endpoint, body) = ai_protocol::chat(&probe, protocol, ping, None, false);
    // connect_timeout 只管建连，服务端接受连接后迟迟不响应（队列排队、鉴权卡住）仍会永久挂住，
    // 因此再套一层整体超时：30 秒内拿不到响应就判定不可用。
    let pending = endpoint
        .apply(client.post(&endpoint.url))
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
    ai_protocol::completion_text(protocol, &text)
}

/// 拉取当前 base_url 下的可用模型列表（GET /models），供设置页下拉选择。
/// 服务商不提供该接口时会报错，设置页提示改为手工填写即可。
#[tauri::command]
pub async fn ai_list_models(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let ai = effective_ai(&app)?;
    let client = build_client()?;
    let protocol = ai_protocol::Protocol::resolve(&ai.protocol, &ai.base_url);
    let endpoint = ai_protocol::models(&ai, protocol);
    let resp = timeout(
        TEST_TIMEOUT,
        endpoint.apply(client.get(&endpoint.url)).send(),
    )
    .await
    .map_err(|_| "拉取模型列表超时（30 秒）".to_string())?
    .map_err(|e| format!("连接失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(readable_http_error(status.as_u16(), &text));
    }
    let out = ai_protocol::model_ids(protocol, &text);
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

/// 从 AppConfig 构造回传前端的掩码视图；key 相关字段基于「生效 key」计算
/// （生效 key = 系统凭据库优先，回退 config.json 明文）。
/// `api_key_plaintext` 为 true 时前端需明示明文落盘风险。
fn public_of(
    app: &tauri::AppHandle,
    cfg: &files::AppConfig,
    effective_key: &str,
    api_key_plaintext: bool,
) -> AiConfigPublic {
    let ai = cfg.ai.clone().unwrap_or_default();
    AiConfigPublic {
        enabled: ai.enabled,
        provider: ai.provider,
        protocol: ai.protocol,
        base_url: ai.base_url,
        model: ai.model,
        max_chars: ai.max_chars,
        confirm_edit: ai.confirm_edit,
        temperature: ai.temperature,
        thinking: ai.thinking.clone(),
        ctx_token_budget: ai.ctx_token_budget,
        ctx_max_messages: ai.ctx_max_messages,
        ctx_scope: ai.ctx_scope.clone(),
        agent_rounds: ai.agent_rounds,
        first_byte_timeout: ai.first_byte_timeout,
        idle_timeout: ai.idle_timeout,
        stream_retries: ai.stream_retries,
        max_tokens: ai.max_tokens,
        system_prompt: ai.system_prompt.clone(),
        profiles: ai
            .profiles
            .iter()
            .map(|p| {
                // 档位 Key 存在凭据库里，config.json 通常为空：掩码按生效 Key 算
                let (key, plaintext) = effective_profile_key(app, &p.id);
                AiProfilePublic {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    base_url: p.base_url.clone(),
                    model: p.model.clone(),
                    temperature: p.temperature,
                    protocol: p.protocol.clone(),
                    has_api_key: !key.trim().is_empty(),
                    api_key_masked: mask_api_key(&key),
                    api_key_plaintext: plaintext,
                }
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
        price_input: ai.price_input,
        price_output: ai.price_output,
        has_api_key: !effective_key.is_empty(),
        api_key_masked: mask_api_key(effective_key),
        api_key_plaintext,
    }
}

/// API Key 掩码：长度 <= 8 返回同长度的 `*`；否则前 3 位 + `****` + 后 4 位。
pub(super) fn mask_api_key(key: &str) -> String {
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

/// 取「生效 key」：系统凭据库优先；为空则回退 config.json 明文，
/// 并在读到时尝试一次性迁移（写入凭据库成功后清空 config.json 明文；失败则保持明文回退）。
/// 返回 (key, 是否仍明文落盘)：明文号只可能来自 config.json 且未能迁走。
fn effective_api_key(app: &tauri::AppHandle) -> (String, bool) {
    if let Some(key) = secret::load_key().filter(|k| !k.trim().is_empty()) {
        return (key, false);
    }
    let mut app_cfg = files::load_app_config(app);
    let plain = app_cfg
        .ai
        .as_ref()
        .map(|a| a.api_key.clone())
        .unwrap_or_default();
    if plain.trim().is_empty() {
        return (String::new(), false);
    }
    // 迁移：明文写入凭据库成功后，把 config.json 的明文清空并写回（一次性）
    if secret::store_key(&plain) {
        if let Some(ai) = app_cfg.ai.as_mut() {
            ai.api_key = String::new();
        }
        match files::save_app_config(app, &app_cfg) {
            Ok(()) => {
                tracing::info!("api key migrated out of config.json");
                (plain, false)
            }
            Err(e) => {
                tracing::warn!("clear plaintext api key in config failed: {e}");
                (plain, true)
            }
        }
    } else {
        (plain, true)
    }
}

/// 取「档位生效 key」：该档凭据库账户（`ai-api-key:profile:<id>`）优先；为空则回退
/// config.json 里该档明文，并尝试一次性迁移（写凭据库成功后清空该档明文；失败保持明文回退）。
/// 返回 (key, 是否仍明文落盘)。空串表示该档未设独立 Key，由调用方继承全局。
fn effective_profile_key(app: &tauri::AppHandle, profile_id: &str) -> (String, bool) {
    let account = secret::profile_account(profile_id);
    if let Some(key) = secret::load_key_for(&account).filter(|k| !k.trim().is_empty()) {
        return (key, false);
    }
    let mut app_cfg = files::load_app_config(app);
    let plain = app_cfg
        .ai
        .as_ref()
        .and_then(|a| a.profiles.iter().find(|p| p.id == profile_id))
        .map(|p| p.api_key.clone())
        .unwrap_or_default();
    if plain.trim().is_empty() {
        return (String::new(), false);
    }
    if secret::store_key_for(&account, &plain) {
        if let Some(ai) = app_cfg.ai.as_mut() {
            if let Some(p) = ai.profiles.iter_mut().find(|p| p.id == profile_id) {
                p.api_key = String::new();
            }
        }
        match files::save_app_config(app, &app_cfg) {
            Ok(()) => {
                tracing::info!("profile api key migrated out of config.json");
                (plain, false)
            }
            Err(e) => {
                tracing::warn!("clear plaintext profile api key in config failed: {e}");
                (plain, true)
            }
        }
    } else {
        (plain, true)
    }
}

/// 档位覆盖：非空的档位项优先，空项继承全局。temperature 无「未设置」语义，始终取档位值。
/// `api_key` 为该档生效 Key（空串=继承全局），不直接取档位配置里的明文字段。
pub(super) fn apply_profile(ai: &mut AiConfig, p: &files::AiProfile, api_key: &str) {
    if !p.base_url.trim().is_empty() {
        ai.base_url = p.base_url.clone();
    }
    if !p.model.trim().is_empty() {
        ai.model = p.model.clone();
    }
    if !p.protocol.trim().is_empty() {
        ai.protocol = p.protocol.clone();
    }
    if !api_key.trim().is_empty() {
        ai.api_key = api_key.to_string();
    }
    ai.temperature = p.temperature;
}

/// 请求就绪判断：Base URL + 模型名。API Key 可为空——本地模型（Ollama / LM Studio）不吃 Key。
pub(super) fn request_ready(ai: &AiConfig) -> bool {
    !ai.base_url.trim().is_empty() && !ai.model.trim().is_empty()
}

/// 读配置并校验：base_url / model 为空时返回统一错误
pub(super) fn effective_ai(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let mut ai = files::load_app_config(app).ai.unwrap_or_default();
    ai.api_key = effective_api_key(app).0;
    // 档位覆盖：选中某个档位时，用它的地址 / 模型 / 协议 / Key / 温度
    if !ai.active_profile.trim().is_empty() {
        if let Some(p) = ai
            .profiles
            .iter()
            .find(|p| p.id == ai.active_profile)
            .cloned()
        {
            let (key, _) = effective_profile_key(app, &p.id);
            apply_profile(&mut ai, &p, &key);
        }
    }
    if !request_ready(&ai) {
        return Err(NOT_CONFIGURED.to_string());
    }
    Ok(ai)
}
