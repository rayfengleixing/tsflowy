import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/invoke";

// AI 助手 invoke 封装：配置读写 / 连接测试 / 流式对话 / 取消。
// 契约由 Rust 侧固定，JS 参数一律 camelCase（Tauri 2 自动映射到 Rust snake_case）；
// 配置读取返回值字段名为 Rust serde 结构体字段（snake_case）。

/** `ai_get_config` 返回的配置（Rust 侧字段名即 JSON 键名） */
export interface AiConfig {
  enabled: boolean;
  provider: string;
  base_url: string;
  model: string;
  max_chars: number;
  /** AI 自主修改文档前先弹 diff 确认 */
  confirm_edit: boolean;
  /** 采样温度 0–2 */
  temperature: number;
  /** 最大 token 数，0 表示不限制 */
  max_tokens: number;
  /** 用户追加的自定义系统提示 */
  system_prompt: string;
  profiles: AiProfile[];
  /** 当前生效档位 id，空串表示单档配置 */
  active_profile: string;
  quick_actions: AiQuickActionDef[];
  has_api_key: boolean;
  api_key_masked: string;
}

export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 一个模型档位：同一套 Key 下切换不同服务商 / 模型 / 温度 */
export interface AiProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  temperature: number;
}

/** 用户自定义快捷指令；scope 决定用哪段文本填进提示词 */
export interface AiQuickActionDef {
  id: string;
  name: string;
  /** 提示词模板，含 {content} 占位符（scope 为 none 时不需要） */
  prompt: string;
  scope: "selection" | "page" | "none";
}

/** 单次请求的 token 用量（服务商未返回时字段为 null） */
export interface AiUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

/** `ai_chat` 流式事件：chunk 增量 / reasoning 思考增量 / done 收尾全量与用量 / error 报错 */
export type AiChatEvent =
  | { type: "chunk"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; full: string; usage?: AiUsage | null }
  /** code 为错误归类码（auth / rate_limit / quota / timeout / network / server …），可能为 null */
  | { type: "error"; message: string; code?: string | null };

/** 服务商预设：选中后自动填充 Base URL 与模型（用户仍可手改） */
export interface AiProviderPreset {
  id: string;
  baseUrl: string;
  model: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: "custom", baseUrl: "", model: "" },
  { id: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
];

/** 统一把任意异常转成可展示的字符串（invoke 失败时通常抛出 string） */
export function aiErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function aiGetConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}

/** apiKey：null = 不修改，"" = 清空（Rust 侧语义）；空串与 null 由调用方区分 */
export async function aiSaveConfig(input: {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  maxChars: number;
  confirmEdit: boolean;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  profiles: AiProfile[];
  activeProfile: string;
  quickActions: AiQuickActionDef[];
  apiKey: string | null;
}): Promise<void> {
  // 顶层参数名走 Tauri 的 camelCase 映射，但结构体内部字段由 serde 按 Rust 原名反序列化，
  // 因此这里必须显式转回 snake_case，否则会报 missing field `base_url`
  await invoke("ai_save_config", {
    cfg: {
      enabled: input.enabled,
      provider: input.provider,
      base_url: input.baseUrl,
      model: input.model,
      max_chars: input.maxChars,
      confirm_edit: input.confirmEdit,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      system_prompt: input.systemPrompt,
      profiles: input.profiles,
      active_profile: input.activeProfile,
      quick_actions: input.quickActions,
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

/** 库中的 AI 会话行；messages 是整条会话消息数组的 JSON 字符串 */
export interface AiSessionRow {
  id: string;
  title: string;
  page_id: string | null;
  page_title: string | null;
  updated_at: string;
  messages: string;
}

/** 读取库中的 AI 会话（按 updated_at 降序） */
export async function aiSessionList(): Promise<AiSessionRow[]> {
  return invoke<AiSessionRow[]>("ai_session_list");
}

/** 整份覆盖保存 AI 会话 */
export async function aiSessionSaveAll(sessions: AiSessionRow[]): Promise<void> {
  await invoke("ai_session_save_all", { sessions });
}

/** 流式对话：用 Channel 接收事件，逐段回调给上层 */
export async function aiChat(messages: AiChatMessage[], onEvent: (ev: AiChatEvent) => void): Promise<void> {
  const channel = new Channel<AiChatEvent>();
  channel.onmessage = onEvent;
  // Rust 侧签名为 ai_chat(req, on_event)：参数名要一一对应（req / onEvent）
  await invoke("ai_chat", { req: { messages }, onEvent: channel });
}

export async function aiCancel(): Promise<void> {
  await invoke("ai_cancel");
}

/**
 * 单篇文档内检索与问题相关的片段（AI @ 引用的上下文用）。
 * 命中为空（查询太短 / 该文档还没进索引）时返回空数组，调用方回退到整篇截断。
 */
export async function docSearchSnippets(viewId: string, query: string, limit = 8): Promise<string[]> {
  return invoke<string[]>("doc_search_snippets", { viewId, query, limit });
}
