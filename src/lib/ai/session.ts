// AI 会话行的读写：messages 是整条消息数组的 JSON 字符串，整行覆盖式保存。

import { invoke } from "@/lib/invoke";

/** 库中的 AI 会话行；messages 是整条会话消息数组的 JSON 字符串 */
export interface AiSessionRow {
  id: string;
  title: string;
  page_id: string | null;
  page_title: string | null;
  updated_at: string;
  messages: string;
  /** 会话累计输入 token（017 列） */
  prompt_tokens: number;
  /** 会话累计输出 token */
  completion_tokens: number;
  /** 归档位：归档的会话不进日常历史列表，仍可检索与还原 */
  archived: boolean;
}

/** 读取库中的 AI 会话（按 updated_at 降序） */
export async function aiSessionList(): Promise<AiSessionRow[]> {
  return invoke<AiSessionRow[]>("ai_session_list");
}

/** 保存单个会话（存在则整行覆盖） */
export async function aiSessionSave(session: AiSessionRow): Promise<void> {
  await invoke("ai_session_save", { session });
}

/** 删除单个会话（幂等） */
export async function aiSessionDelete(id: string): Promise<void> {
  await invoke("ai_session_delete", { id });
}
