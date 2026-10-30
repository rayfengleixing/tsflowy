// 一次请求的三条出口：流式对话（Channel 逐段回调）、取消、单篇文档片段检索。
// aiErrorText 把 invoke 抛出的任何东西（多数时候是 string）转成可展示文案。

import { Channel } from "@/lib/ipc/ipc-core";
import { invoke } from "@/lib/invoke";
import type { AiChatEvent, AiChatMessage, AiToolSpec } from "./types";

/** 统一把任意异常转成可展示的字符串（invoke 失败时通常抛出 string） */
export function aiErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 流式对话：用 Channel 接收事件，逐段回调给上层。tools 为 agent 工具定义（前端编排多步循环） */
export async function aiChat(
  messages: AiChatMessage[],
  onEvent: (ev: AiChatEvent) => void,
  tools?: AiToolSpec[],
): Promise<void> {
  const channel = new Channel<AiChatEvent>();
  channel.onmessage = onEvent;
  // Rust 侧签名为 ai_chat(req, on_event)：参数名要一一对应（req / onEvent）
  await invoke("ai_chat", { req: { messages, tools: tools ?? null }, onEvent: channel });
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
