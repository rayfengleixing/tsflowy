// AiPanel 的纯函数与常量（从 AiPanel.tsx 原样搬出，无逻辑改动）
import { type MessageKey } from "@/lib/i18n";
import { type StoredSession } from "@/stores/ai";

/** 选择框只放行 Rust 侧认得的那几种图片（与 AI_IMAGE_MIME_BY_EXT 一致） */
export const AI_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/** 历史会话筛选：归档区分区 + 关键词（命中标题或任一消息正文，大小写不敏感） */
export function filterHistorySessions(list: StoredSession[], archived: boolean, query: string): StoredSession[] {
  const q = query.trim().toLowerCase();
  return list.filter((x) => {
    if (!!x.archived !== archived) return false;
    if (!q) return true;
    return x.title.toLowerCase().includes(q) || x.messages.some((m) => m.content.toLowerCase().includes(q));
  });
}

/** 错误归类码 → 对应的处理引导（Rust 侧下发 code） */
export const AI_ERROR_HINT: Record<string, MessageKey> = {
  auth: "ai.errorHintAuth",
  rate_limit: "ai.errorHintRateLimit",
  quota: "ai.errorHintQuota",
  timeout: "ai.errorHintTimeout",
  network: "ai.errorHintNetwork",
  server: "ai.errorHintServer",
  request: "ai.errorHintRequest",
  context_length: "ai.errorHintContextLength",
  not_configured: "ai.errorHintNotConfigured",
  cancelled: "ai.errorHintCancelled",
};

/** 取 Base URL 的主机名用于隐私提示；解析失败时原样返回 */
export function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}
