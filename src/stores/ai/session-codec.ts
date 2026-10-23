import { newId } from "@/lib/db";
import { type AiSessionRow, type AiImageAttachment } from "@/lib/ai";
import { validateCall } from "@/lib/ai-edit";
import { sanitizeUndoPlan } from "@/lib/ai-tools";
import { t } from "@/lib/i18n";
import { AiActionRecord, AiEditState, AiMessage, SessionUsage, StoredSession } from "./types";
import { contentOf, invalidActionRecord, isRetrievalCall } from "./calls";
import { MAX_MESSAGE_CHARS, MAX_SESSIONS, MAX_SESSION_MESSAGES, SESSIONS_KEY } from "./limits";
// 会话的编解码：localStorage 快照读写、坏数据清洗、会话行与本地形状互转、显示窗口。

/**
 * 历史面板的显示窗口：归档会话全部保留（用户明确要留档），
 * 普通会话按列表原序（updated_at 降序）取前 limit 条；其余靠「加载更多」放量。
 */
export function visibleSessionWindow(sessions: StoredSession[], limit: number): StoredSession[] {
  const out: StoredSession[] = [];
  let normal = 0;
  for (const s of sessions) {
    if (s.archived) out.push(s);
    else if (normal++ < limit) out.push(s);
  }
  return out;
}
export function sanitizeUsage(raw: unknown): SessionUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const prompt = num(rec.prompt);
  const completion = num(rec.completion);
  return prompt > 0 || completion > 0 ? { prompt, completion } : undefined;
}

export function toSessionRow(s: StoredSession): AiSessionRow {
  return {
    id: s.id,
    title: s.title,
    page_id: s.pageId ?? null,
    page_title: s.pageTitle ?? null,
    updated_at: String(s.updatedAt),
    messages: JSON.stringify(s.messages),
    prompt_tokens: s.usage?.prompt ?? 0,
    completion_tokens: s.usage?.completion ?? 0,
    archived: s.archived ?? false,
  };
}

export function fromSessionRow(row: AiSessionRow): StoredSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.messages);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const messages = parsed.map((x) => sanitizeMessage(x, row.page_id ?? null)).filter((m): m is AiMessage => m !== null);
  if (messages.length === 0) return null;
  return {
    id: row.id,
    title: row.title,
    updatedAt: Number(row.updated_at) || Date.now(),
    messages,
    pageId: row.page_id,
    pageTitle: row.page_title,
    usage: sanitizeUsage({ prompt: row.prompt_tokens, completion: row.completion_tokens }),
    archived: row.archived === true,
  };
}
/** 会话标题：第一条用户消息前 30 字 */
export function sessionTitle(messages: AiMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return t("ai.fallbackTitle");
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/** 恢复出来的动作状态必须是已知值；撤销句柄属于当时的编辑器实例，一律不恢复 */
export const RESTORABLE_STATES: readonly AiEditState[] = ["pending", "applied", "rejected", "unavailable", "malformed"];

/**
 * 恢复一张动作卡片。apply_edit 的撤销依赖 revert 句柄，这里刻意不恢复它：
 * 重启后编辑器 undo 栈已空，撤销会错伤无关内容。
 * 页面/表数据动作的 undo 是纯数据逆操作，照原样恢复 —— 这正是它能跨重启撤销的原因。
 */
export function sanitizeAction(raw: unknown, pageId: string | null): AiActionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (!RESTORABLE_STATES.includes(a.state as AiEditState)) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (a.tool === "invalid") return invalidActionRecord();
  const call = validateCall(a.call);
  // 只读检索不产生卡片，历史里出现这种脏数据直接丢掉
  if (!call || isRetrievalCall(call)) return null;
  const undo = sanitizeUndoPlan(a.undo);
  const record: AiActionRecord = {
    tool: call.tool,
    call,
    op: call.tool === "apply_edit" ? call.args.op : null,
    summary: text(a.summary),
    content: contentOf(call),
    before: text(a.before),
    state: a.state as AiEditState,
    ...(a.undone === true ? { undone: true } : {}),
    ...(text(a.pageName) ? { pageName: text(a.pageName) } : {}),
    ...(text(a.detail) ? { detail: text(a.detail) } : {}),
    ...(undo ? { undo } : {}),
  };
  // 恢复出的待确认改文档没写落点时，钉回会话发起的那一页：
  // 否则用户切到别的页面点「应用」，改动会落到当前打开的文档上
  if (record.state === "pending" && call.tool === "apply_edit" && !call.args.view_id && pageId) {
    record.call = { ...call, args: { ...call.args, view_id: pageId } };
  }
  return record;
}

/** 图片附件恢复：只认 assets/ 之内的相对路径，与会话里存的形态一致（base64 从不入库） */
export function sanitizeImages(raw: unknown): AiImageAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const img = x as Record<string, unknown>;
    if (typeof img.path !== "string" || !img.path.startsWith("assets/")) return [];
    return [{ name: typeof img.name === "string" ? img.name : "图片", path: img.path }];
  });
  return out.length > 0 ? out : undefined;
}

/** 恢复时逐条校验消息；动作卡片一并恢复，切回历史会话仍能看到并处理待确认的改动 */
export function sanitizeMessage(raw: unknown, pageId: string | null = null): AiMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
  const actions = Array.isArray(m.actions)
    ? m.actions.map((x) => sanitizeAction(x, pageId)).filter((x): x is AiActionRecord => x !== null)
    : [];
  const images = sanitizeImages(m.images);
  // 评分不白名单化就会被恢复流程丢掉，重开面板就看不到自己标过的好/坏
  const rating = m.rating === "up" || m.rating === "down" ? m.rating : undefined;
  const incomplete = m.incomplete === "error" || m.incomplete === "stopped" ? m.incomplete : undefined;
  return {
    id: typeof m.id === "string" && m.id ? m.id : newId(),
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
    ...(actions.length > 0 ? { actions } : {}),
    ...(images ? { images } : {}),
    ...(rating ? { rating } : {}),
    ...(incomplete ? { incomplete } : {}),
  };
}

export function restoreSession(raw: unknown): StoredSession | null {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).messages)) return null;
  const rec = raw as Record<string, unknown>;
  const pageId = typeof rec.pageId === "string" ? rec.pageId : null;
  const messages = (rec.messages as unknown[])
    .slice(-MAX_SESSION_MESSAGES)
    .map((x) => sanitizeMessage(x, pageId))
    .filter((m): m is AiMessage => m !== null);
  if (messages.length === 0) return null;
  return {
    id: typeof rec.id === "string" && rec.id ? rec.id : newId(),
    title: typeof rec.title === "string" && rec.title ? rec.title : sessionTitle(messages),
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
    messages,
    pageId: typeof rec.pageId === "string" ? rec.pageId : null,
    pageTitle: typeof rec.pageTitle === "string" ? rec.pageTitle : null,
    usage: sanitizeUsage(rec.usage),
    archived: rec.archived === true,
  };
}

/** 从 localStorage 恢复会话（损坏/缺失时返回空态）——库不可用时的兜底来源 */
export function loadSessionsFromStorage(): {
  activeId: string;
  sessions: StoredSession[];
  active: StoredSession | null;
} {
  const empty = { activeId: newId(), sessions: [] as StoredSession[], active: null as StoredSession | null };
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return empty;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const sessions = Array.isArray(data.sessions)
      ? (data.sessions as unknown[])
          .slice(0, MAX_SESSIONS)
          .map(restoreSession)
          .filter((s): s is StoredSession => s !== null)
      : [];
    const active = restoreSession(data.active);
    return { activeId: active?.id ?? empty.activeId, sessions, active };
  } catch {
    return empty;
  }
}
/** localStorage 里那份会话快照的形状 */
export type LocalSessions = ReturnType<typeof loadSessionsFromStorage>;
