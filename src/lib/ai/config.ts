// 配置读写与连接测试：ai_get_config / ai_save_config / ai_test_connection / ai_list_models。

import { invoke } from "@/lib/invoke";
import type { AiProfile, AiProfilePublic } from "./profile";

/** `ai_get_config` 返回的配置（Rust 侧字段名即 JSON 键名） */
export interface AiConfig {
  enabled: boolean;
  provider: string;
  /** 接口协议族："" = 按 base_url 自动识别，或 openai / anthropic / gemini */
  protocol: string;
  base_url: string;
  model: string;
  max_chars: number;
  /** AI 自主修改文档前先弹 diff 确认 */
  confirm_edit: boolean;
  /** 采样温度 0–2 */
  temperature: number;
  /** 思考模式：auto = 不下发推理参数（默认），off = 显式关闭思考 */
  thinking: string;
  /** 上下文 token 预算（历史消息回截的估算上限） */
  ctx_token_budget: number;
  /** 上下文消息条数上限 */
  ctx_max_messages: number;
  /** 随请求下发的上下文范围：full / page_only / off */
  ctx_scope: string;
  /** 最大 token 数，0 表示不限制 */
  max_tokens: number;
  /** 用户追加的自定义系统提示 */
  system_prompt: string;
  profiles: AiProfilePublic[];
  /** 当前生效档位 id，空串表示单档配置 */
  active_profile: string;
  quick_actions: AiQuickActionDef[];
  /** 是否用 function calling 下发编辑指令（默认关闭，兼容工具支持不全的服务商） */
  use_tools: boolean;
  /** 输入 token 单价（每 100 万 token，货币单位自定），0 = 未填价 */
  price_input: number;
  /** 输出 token 单价（每 100 万 token） */
  price_output: number;
  /** 一次提问内的模型往返上限（agent 检索轮次），Rust 侧夹到 1–12 */
  agent_rounds: number;
  /** 首帧等待上限（秒），本地模型冷启动要调大 */
  first_byte_timeout: number;
  /** 流式帧间静默上限（秒） */
  idle_timeout: number;
  /** 流开始前的重试次数，0 = 明确不重试 */
  stream_retries: number;
  has_api_key: boolean;
  api_key_masked: string;
  /** true = 系统凭据库不可用（或明文清不掉），Key 目前明文存于 config.json */
  api_key_plaintext?: boolean;
}

/** 用户自定义快捷指令；scope 决定用哪段文本填进提示词 */
export interface AiQuickActionDef {
  id: string;
  name: string;
  /** 提示词模板，含 {content} 占位符（scope 为 none 时不需要） */
  prompt: string;
  scope: "selection" | "page" | "none";
}

export async function aiGetConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}

/** apiKey：null = 不修改，"" = 清空（Rust 侧语义）；空串与 null 由调用方区分 */
export async function aiSaveConfig(input: {
  enabled: boolean;
  provider: string;
  protocol: string;
  baseUrl: string;
  model: string;
  maxChars: number;
  confirmEdit: boolean;
  temperature: number;
  /** "auto" | "off" */
  thinking: string;
  ctxTokenBudget: number;
  ctxMaxMessages: number;
  /** "full" | "page_only" | "off"，其它值由 Rust 侧归一为 full */
  ctxScope: string;
  maxTokens: number;
  systemPrompt: string;
  profiles: AiProfile[];
  activeProfile: string;
  quickActions: AiQuickActionDef[];
  useTools: boolean;
  /** token 单价（每 100 万 token），0 = 未填价、不做费用估算 */
  priceInput: number;
  priceOutput: number;
  /** agent 检索轮次上限；0 = 交给 Rust 回落默认 */
  agentRounds: number;
  /** 首帧等待秒数；0 = 回落默认 */
  firstByteTimeout: number;
  /** 帧间静默秒数；0 = 回落默认 */
  idleTimeout: number;
  /** 流开始前重试次数；0 = 不重试（与上面三项的「0=默认」不同） */
  streamRetries: number;
  apiKey: string | null;
}): Promise<void> {
  // 顶层参数名走 Tauri 的 camelCase 映射，但结构体内部字段由 serde 按 Rust 原名反序列化，
  // 因此这里必须显式转回 snake_case，否则会报 missing field `base_url`
  await invoke("ai_save_config", {
    cfg: {
      enabled: input.enabled,
      provider: input.provider,
      protocol: input.protocol,
      base_url: input.baseUrl,
      model: input.model,
      max_chars: input.maxChars,
      confirm_edit: input.confirmEdit,
      temperature: input.temperature,
      thinking: input.thinking,
      ctx_token_budget: input.ctxTokenBudget,
      ctx_max_messages: input.ctxMaxMessages,
      ctx_scope: input.ctxScope,
      max_tokens: input.maxTokens,
      system_prompt: input.systemPrompt,
      profiles: input.profiles,
      active_profile: input.activeProfile,
      quick_actions: input.quickActions,
      use_tools: input.useTools,
      price_input: input.priceInput,
      price_output: input.priceOutput,
      agent_rounds: input.agentRounds,
      first_byte_timeout: input.firstByteTimeout,
      idle_timeout: input.idleTimeout,
      stream_retries: input.streamRetries,
      api_key: input.apiKey,
    },
  });
}

export async function aiTestConnection(): Promise<string> {
  return invoke<string>("ai_test_connection");
}

/** 拉取当前 Base URL 下的可用模型列表；服务商不提供该接口时会抛错 */
export async function aiListModels(): Promise<string[]> {
  return invoke<string[]>("ai_list_models");
}
