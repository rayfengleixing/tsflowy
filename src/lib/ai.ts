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
  has_api_key: boolean;
  api_key_masked: string;
}

export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** `ai_chat` 流式事件：chunk 增量 / reasoning 思考增量 / done 收尾全量 / error 报错 */
export type AiChatEvent =
  | { type: "chunk"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; full: string }
  | { type: "error"; message: string };

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
      api_key: input.apiKey,
    },
  });
}

export async function aiTestConnection(): Promise<string> {
  return invoke<string>("ai_test_connection");
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
