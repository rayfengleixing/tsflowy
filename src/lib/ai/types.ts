// AI 与 Rust 之间的对话契约类型：消息、工具调用、流式事件与用量。
// 形状改动等于改 IPC 契约，属行为变更，不在机械拆分范围内。

export interface AiChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** assistant 携带的工具调用（agent 循环回灌时原样带回服务端） */
  tool_calls?: AiToolCallRef[];
  /** role=tool 时对应的调用 id */
  tool_call_id?: string;
  /** 图片附件：只给 assets/ 相对路径，base64 由 Rust 发请求前按 path 读出内联 */
  images?: { path: string }[];
}

/** OpenAI 协议下的一个函数调用回传 */
export interface AiToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** `ai_chat` 下发的工具定义（OpenAI tools 数组元素） */
export interface AiToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
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
  | { type: "done"; full: string; usage?: AiUsage | null; tool_calls?: AiToolCallRaw[] }
  /** code 为错误归类码（auth / rate_limit / quota / timeout / network / server / context_length …），可能为 null */
  | { type: "error"; message: string; code?: string | null };

/** Rust 侧回传的完整函数调用（Done.tool_calls / 事件流内累积） */
export interface AiToolCallRaw {
  id: string;
  name: string;
  /** JSON 字符串形式的参数 */
  arguments: string;
}
