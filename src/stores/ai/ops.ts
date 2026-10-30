import { aiSessionSave, type AiConfig } from "@/lib/ai";
import { getAiEditor, getAiEditorForView } from "@/lib/ai/ai-editor";
import type { LocateFailure } from "@/lib/ai/ai-locate";
import type { MessageKey } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import { SESSIONS_KEY } from "./limits";
import { sessionTitle, toSessionRow } from "./session-codec";
import type { AiMessage, SessionUsage, StoredSession } from "./types";

// 动作的构件里不读 store 状态的那一批：入参给足、纯算或只打下游模块，因此放在工厂外面而不是 create 的闭包里。

/**
 * 当前对话有内容时归档进 sessions，供 newChat / 切换会话复用。
 * 不再按条数上限淘汰：库里的会话全部保留，显示窗口在面板侧控制，
 * 否则「列表里看得见 100 条、下次 newChat 悄悄删掉 80 条」比截断展示更糟。
 * archived 为刚落档的会话。
 */
export const archiveCurrent = (s: {
  messages: AiMessage[];
  sessions: StoredSession[];
  activeSessionId: string;
  sessionPageId: string | null;
  sessionPageTitle: string | null;
  usageTotal: { prompt: number; completion: number; total: number };
}): { sessions: StoredSession[]; archived: StoredSession | null } => {
  if (s.messages.length === 0) return { sessions: s.sessions, archived: null };
  const entry: StoredSession = {
    id: s.activeSessionId,
    title: sessionTitle(s.messages),
    updatedAt: Date.now(),
    messages: s.messages,
    pageId: s.sessionPageId,
    pageTitle: s.sessionPageTitle,
    usage: { prompt: s.usageTotal.prompt, completion: s.usageTotal.completion },
  };
  return { sessions: [entry, ...s.sessions], archived: entry };
};

/**
 * 一次性导入老会话：ai_sessions 的建表迁移在 0.8.24 之前从未生效，历史只存在 localStorage。
 * 库空而本地有货时先写进库，全部成功才清掉本地副本 —— 否则下一次启动库里已经有当前会话的行，
 * 本地那份归档就再也读不到了（看起来像用户的历史会话凭空消失）。
 * 返回 false 表示没导成功，调用方继续沿用本地那份，下次启动还会重试。
 */
export const importLocalSessions = async (pending: StoredSession[]): Promise<boolean> => {
  const unique: StoredSession[] = [];
  const seen = new Set<string>();
  for (const s of pending) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    unique.push(s);
  }
  try {
    for (const s of unique) await aiSessionSave(toSessionRow(s));
  } catch (e) {
    logger.warn("ai sessions import from localStorage failed", e);
    return false;
  }
  try {
    localStorage.removeItem(SESSIONS_KEY);
  } catch {
    /* 清不掉只是下次重复导入，按 id upsert 没有副作用 */
  }
  return true;
};

/**
 * 面板里「只改一个字段」的整份回写载荷：`ai_save_config` 是覆盖式保存，
 * 少带一个字段就等于把它悄悄重置成默认值，所以载荷统一由这里生成、只叠增量。
 * profiles 不带 api_key 字段 → Rust 侧按 id 保留各档原有 Key；apiKey=null 表示不改全局 Key。
 */
export const configPayload = (c: AiConfig, over: Record<string, unknown>) => ({
  enabled: c.enabled,
  provider: c.provider,
  protocol: c.protocol,
  baseUrl: c.base_url,
  model: c.model,
  maxChars: c.max_chars,
  confirmEdit: c.confirm_edit,
  temperature: c.temperature,
  thinking: c.thinking,
  ctxTokenBudget: c.ctx_token_budget,
  ctxMaxMessages: c.ctx_max_messages,
  ctxScope: c.ctx_scope,
  maxTokens: c.max_tokens,
  systemPrompt: c.system_prompt,
  profiles: c.profiles,
  activeProfile: c.active_profile,
  quickActions: c.quick_actions,
  useTools: c.use_tools,
  priceInput: c.price_input,
  priceOutput: c.price_output,
  agentRounds: c.agent_rounds,
  firstByteTimeout: c.first_byte_timeout,
  idleTimeout: c.idle_timeout,
  streamRetries: c.stream_retries,
  apiKey: null,
  ...over,
});

/** 定位失败原因 → 界面文案 */
export const LOCATE_REASON: Record<LocateFailure["reason"], MessageKey> = {
  no_doc: "ai.noPage",
  heading_not_found: "ai.locateHeadingNotFound",
  text_not_found: "ai.locateTextNotFound",
  protected_heading: "ai.locateProtectedHeading",
  bad_structure: "ai.locateBlockedByLock",
};

/** 当前编辑器桥接与正在打开的页面（apply_edit 不带 view_id 时的落点） */
export const editorTarget = () => ({
  bridge: getAiEditor(),
  currentId: useWorkspaceStore.getState().currentViewId,
});

/** 指定视图的落地桥接：主栏/副栏打开中的页面一律就地走编辑器事务；未打开时返回 null 走 JSON 直写 */
export const bridgeFor = (
  view_id: string | undefined,
  currentBridge: ReturnType<typeof getAiEditor>,
  currentId: string | null,
) => {
  if (!view_id) return currentBridge;
  if (currentBridge && currentId === view_id) return currentBridge;
  return getAiEditorForView(view_id);
};

/** 库里存的用量 → 面板用的累计三元组（老会话没单独记 total，用输入+输出兜底） */
export const sessionUsageTotal = (u?: SessionUsage) => ({
  prompt: u?.prompt ?? 0,
  completion: u?.completion ?? 0,
  total: (u?.prompt ?? 0) + (u?.completion ?? 0),
});
