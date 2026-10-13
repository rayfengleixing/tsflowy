import { create } from "zustand";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/invoke";
import { newId } from "@/lib/db";
import {
  aiCancel,
  aiChat,
  aiErrorText,
  aiGetConfig,
  aiSaveConfig,
  aiSessionList,
  aiSessionSave,
  aiSessionDelete,
  aiUsageSummary,
  docSearchSnippets,
  type AiSessionRow,
  type AiUsageSummary,
  type AiChatEvent,
  type AiChatMessage,
  type AiConfig,
  type AiImageAttachment,
  type AiQuickActionDef,
  type AiToolCallRaw,
  type AiToolCallRef,
  type AiUsage,
} from "@/lib/ai";
import { getAiEditor, getAiEditorForView, type AiEditRevert } from "@/lib/ai-editor";
import {
  buildEditSystemPrompt,
  CHAT_ONLY_SYSTEM_PROMPT,
  extractCalls,
  hideEditBlock,
  retrievalResultMessage,
  RETRIEVAL_TOOLS,
  validateCall,
  type AiCall,
  type AiEditAnchor,
  type AiEditOp,
  type AiWriteCall,
  type RetrievalCall,
  type RetrievalKind,
} from "@/lib/ai-edit";
import { aiToolSpecs, resolvePage, runRetrievalCall, runWriteAction } from "@/lib/ai-tools";
import { applyEditToDocJson, asDoc, type LocateFailure } from "@/lib/ai-locate";
import { parseMentions } from "@/lib/ai-mention";
import { estimateTokens, tailTokens } from "@/lib/ai-tokens";
import { documentApi } from "@/lib/documents";
import { jsonToMarkdown } from "@/lib/markdown";
import { flattenTree } from "@/lib/tree";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import type { JSONContent } from "@tiptap/core";
import type { ViewNode } from "@/types/models";
import { t, type MessageKey } from "@/lib/i18n";

// AI 助手面板状态：开关/宽度（localStorage 偏好）、消息列表、流式状态、
// 配置缓存与 send / stop / clear / retry / quickAction / undoAction 动作。

/**
 * 动作的落地状态：
 * pending 待用户确认 / applied 已写入 / rejected 已忽略 /
 * unavailable 没有可编辑文档、定位失败或执行报错 / malformed 指令块解析失败
 */
export type AiEditState = "pending" | "applied" | "rejected" | "unavailable" | "malformed";

/** 一条回复附带的动作（改文档 / 建页 / 改标题 / 加表行）及其落地情况 */
export interface AiActionRecord {
  tool: AiWriteCall["tool"] | "invalid";
  /** 动作本体；invalid 卡片为 null（格式有误，没有可执行的东西） */
  call: AiWriteCall | null;
  /** apply_edit 的作用范围；其余动作与解析失败时为 null */
  op: AiEditOp | null;
  summary: string;
  /** 建议写入的 Markdown 内容（建页时为页面正文） */
  content: string;
  /** 将被替换的原文（插入/新增类为空），用于落地前的 diff 预览 */
  before: string;
  state: AiEditState;
  undone?: boolean;
  /** 动作落点页名（跨页面编辑时界面要说明改了哪一页） */
  pageName?: string;
  /** 执行结果说明或失败原因 */
  detail?: string;
  /** 撤销句柄（含改前快照），仅当前编辑器实例内有效，不参与持久化 */
  revert?: AiEditRevert;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 本条回复下发的动作及其落地结果（用于展示、确认与撤销） */
  actions?: AiActionRecord[];
  /** 用户消息附带的图片（assets/ 相对路径，发送时才内联成 base64） */
  images?: AiImageAttachment[];
  /** 回答评分：点赞 / 点踩，未评过为 undefined */
  rating?: "up" | "down";
}

/** 指令块解析失败的占位卡片：没有可执行的动作，也就没有确认与撤销 */
function invalidActionRecord(): AiActionRecord {
  return { tool: "invalid", call: null, op: null, summary: "", content: "", before: "", state: "malformed" };
}

/** 一次提问可能跑多轮（每次检索往返都是一个请求），用量合并成本轮合计 */
function addUsage(turn: AiUsage | null, u: AiUsage): AiUsage {
  return {
    prompt_tokens: (turn?.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
    completion_tokens: (turn?.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
    total_tokens: (turn?.total_tokens ?? 0) + (u.total_tokens ?? 0),
  };
}

/** 快捷动作：前四个基于选中文本，continue 基于整页上下文（不需要选中） */
export type AiQuickAction = "summarize" | "translate" | "rewrite" | "explain" | "continue";

function isRetrievalCall(call: AiCall): call is RetrievalCall {
  return RETRIEVAL_TOOLS.includes(call.tool as RetrievalKind);
}

function isWriteCall(call: AiCall): call is AiWriteCall {
  return !isRetrievalCall(call);
}

/** 动作的正文内容（diff 预览右侧展示；建页用正文，其余写动作没有整段文本） */
function contentOf(call: AiWriteCall): string {
  if (call.tool === "apply_edit") return call.args.content;
  if (call.tool === "create_page") return call.args.content ?? "";
  return "";
}

/** 卡片标题：apply_edit 用模型给的 summary，其余动作按参数自动生成一句说明 */
function summaryOf(call: AiWriteCall): string {
  switch (call.tool) {
    case "apply_edit":
      return call.args.summary ?? "";
    case "create_page":
      return t("ai.actionSummaryCreate", { title: call.args.title });
    case "set_page_title":
      return t("ai.actionSummaryRename", { page: call.args.page, title: call.args.title });
    case "add_database_row":
      return t("ai.actionSummaryAddRow", { database: call.args.database });
  }
}

/** 本轮模型下发的动作：函数调用与文本协议块合并去重（两条路收敛为同一种形态） */
function collectCalls(
  refs: AiToolCallRaw[],
  text: string,
): { items: { call: AiCall; id: string }[]; malformed: boolean } {
  const items: { call: AiCall; id: string }[] = [];
  const seen = new Set<string>();
  let malformed = false;
  const push = (call: AiCall, id: string) => {
    const key = JSON.stringify(call);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ call, id });
  };
  for (const r of refs) {
    let value: unknown;
    try {
      value = JSON.parse(r.arguments || "{}");
    } catch {
      malformed = true;
      continue;
    }
    const obj = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    // 函数调用的工具名在 name 字段里，参数体是裸 args；个别模型会把 {tool,args} 整个塞进 arguments，
    // 那种形态直接交给 validateCall（它与文本协议共用同一种 JSON）
    const call = validateCall("tool" in obj || "op" in obj ? obj : { tool: r.name, args: obj });
    if (!call) malformed = true;
    else push(call, r.id);
  }
  const extracted = extractCalls(text);
  for (const c of extracted.calls) push(c, "");
  return { items, malformed: malformed || extracted.malformed };
}

const PANEL_WIDTH_KEY = "tsflowy-ai-panel-width";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const DEFAULT_MAX_CHARS = 8000;
/**
 * 一次提问内允许的最大模型往返次数：每轮模型可以要求若干次只读检索，
 * 前端执行后把结果喂回模型继续。上限用来兜住「模型反复要求检索却收敛不了」的情况。
 */
const MAX_AGENT_ROUNDS = 4;

export const AI_WIDTH_LIMITS = { min: MIN_WIDTH, max: MAX_WIDTH };

const SESSIONS_KEY = "tsflowy-ai-sessions-v1";
const MAX_SESSIONS = 20;
const MAX_SESSION_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100_000;
// 长对话防超限：历史消息按估算 token 从最新往前收进预算，放不下的早期轮次直接丢弃
// （system prompt 与 @ 引用上下文不占预算，不受影响）。
// 按 token 而非字符计：中文 1 字 ≈ 1 token、拉丁 4 字符 ≈ 1 token，字符预算对两种文本失真严重。
const HISTORY_TOKEN_BUDGET = 3000;
const HISTORY_MAX_MESSAGES = 40;

/** 会话累计 token 用量（服务商不回 usage 时整份为 0） */
export interface SessionUsage {
  prompt: number;
  completion: number;
}

/** 归档的历史会话（不含进行中的当前对话） */
export interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: AiMessage[];
  /** 会话发起时所在的页面：历史会话的上下文是那一页，切换页面后不应混淆 */
  pageId?: string | null;
  pageTitle?: string | null;
  /** 会话累计 token 用量：切回历史会话时据此恢复底部的用量条 */
  usage?: SessionUsage;
  /** 归档位：归档后不进日常历史列表，但仍可检索、可还原，且不受会话条数上限裁剪 */
  archived?: boolean;
}

/** 只认非负有限数：库行/本地 JSON 里的脏值一律按 0 处理，别让 NaN 流进费用估算 */
function sanitizeUsage(raw: unknown): SessionUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const prompt = num(rec.prompt);
  const completion = num(rec.completion);
  return prompt > 0 || completion > 0 ? { prompt, completion } : undefined;
}

function toSessionRow(s: StoredSession): AiSessionRow {
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

function fromSessionRow(row: AiSessionRow): StoredSession | null {
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

/** 当前打开的页面（用于给会话标注上下文来源） */
function currentPageRef(): { id: string; name: string } | null {
  const s = useWorkspaceStore.getState();
  if (!s.currentViewId) return null;
  const node = flattenTree(s.tree).find((v) => v.id === s.currentViewId);
  return { id: s.currentViewId, name: node?.name ?? "" };
}

/** 会话标题：第一条用户消息前 30 字 */
function sessionTitle(messages: AiMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return t("ai.fallbackTitle");
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/** 恢复出来的动作状态必须是已知值；撤销句柄属于当时的编辑器实例，一律不恢复 */
const RESTORABLE_STATES: readonly AiEditState[] = ["pending", "applied", "rejected", "unavailable", "malformed"];

/**
 * 恢复一张动作卡片。撤销按钮依赖 revert 句柄，这里刻意不恢复它：
 * 重启后编辑器 undo 栈已空，撤销会错伤无关内容。
 */
function sanitizeAction(raw: unknown, pageId: string | null): AiActionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (!RESTORABLE_STATES.includes(a.state as AiEditState)) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (a.tool === "invalid") return invalidActionRecord();
  const call = validateCall(a.call);
  // 只读检索不产生卡片，历史里出现这种脏数据直接丢掉
  if (!call || isRetrievalCall(call)) return null;
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
  };
  // 恢复出的待确认改文档没写落点时，钉回会话发起的那一页：
  // 否则用户切到别的页面点「应用」，改动会落到当前打开的文档上
  if (record.state === "pending" && call.tool === "apply_edit" && !call.args.view_id && pageId) {
    record.call = { ...call, args: { ...call.args, view_id: pageId } };
  }
  return record;
}

/** 图片附件恢复：只认 assets/ 之内的相对路径，与会话里存的形态一致（base64 从不入库） */
function sanitizeImages(raw: unknown): AiImageAttachment[] | undefined {
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
function sanitizeMessage(raw: unknown, pageId: string | null = null): AiMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
  const actions = Array.isArray(m.actions)
    ? m.actions.map((x) => sanitizeAction(x, pageId)).filter((x): x is AiActionRecord => x !== null)
    : [];
  const images = sanitizeImages(m.images);
  // 评分不白名单化就会被恢复流程丢掉，重开面板就看不到自己标过的好/坏
  const rating = m.rating === "up" || m.rating === "down" ? m.rating : undefined;
  return {
    id: typeof m.id === "string" && m.id ? m.id : newId(),
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
    ...(actions.length > 0 ? { actions } : {}),
    ...(images ? { images } : {}),
    ...(rating ? { rating } : {}),
  };
}

function restoreSession(raw: unknown): StoredSession | null {
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
function loadSessionsFromStorage(): {
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
type LocalSessions = ReturnType<typeof loadSessionsFromStorage>;

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

const QUICK_PROMPT_KEY: Record<AiQuickAction, MessageKey> = {
  summarize: "ai.prompt.summarize",
  translate: "ai.prompt.translate",
  rewrite: "ai.prompt.rewrite",
  explain: "ai.prompt.explain",
  continue: "ai.prompt.continue",
};

/** 「优化提问」的系统提示：只改写提问本身，不进对话、不下发编辑协议 */
const REFINE_SYSTEM_PROMPT =
  "你是提问改写助手。用户会给你一句要发给笔记应用 AI 助手的提问，请把它改写成 3 个更清晰、更具体的版本。" +
  "每行一条，不要编号、不要引号、不要解释，保持原意，不要回答这个问题本身。";

/** 解析模型给出的改写候选：去掉编号与项目符号，最多 3 条互不重复 */
function parsePromptIdeas(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .replace(/^\s*(?:[-*·•]|\d+[.、)])\s+/, "")
      .trim()
      .replace(/^["「『'`]+|["」』'`]+$/g, "")
      .trim();
    if (!line || line.length > 300 || out.includes(line)) continue;
    out.push(line);
    if (out.length === 3) break;
  }
  return out;
}

/** 从回答正文取页面标题：第一条非空行去掉 Markdown 记号，最多 40 字 */
function pageTitleFrom(content: string): string {
  const line =
    content
      .split("\n")
      .map((l) => l.replace(/^[#>\-*+\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) return t("ai.fallbackTitle");
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

interface AiState {
  open: boolean;
  width: number;
  messages: AiMessage[];
  /** 归档的历史会话（不含进行中的当前对话） */
  sessions: StoredSession[];
  activeSessionId: string;
  /** 推理型模型的思考过程（仅展示，不参与回填/复制） */
  reasoning: string;
  streaming: boolean;
  /** agent 循环里正在本机执行只读检索（模型已回答完上一轮，下一轮请求还没发出） */
  retrieving: boolean;
  error: string | null;
  /** 上一条错误的归类码（auth / rate_limit / quota / timeout / network / server / cancelled） */
  errorCode: string | null;
  /** 当前会话发起时所在的页面（历史会话据此标注上下文来源） */
  sessionPageId: string | null;
  sessionPageTitle: string | null;
  /** 历史会话是否已从库里加载过（避免重复拉取） */
  sessionsLoaded: boolean;
  /** 最近一轮的 token 用量（服务商不返回时保持 null） */
  usage: AiUsage | null;
  /** 本会话累计用量，只在服务商返回用量时累加 */
  usageTotal: { prompt: number; completion: number; total: number };
  /** 库中全部会话的 token 累计（库不可用时为 null，界面隐藏用量条） */
  usageSummary: AiUsageSummary | null;
  config: AiConfig | null;
  configLoaded: boolean;
  /**
   * 从编辑器（浮动工具栏 / 斜杠菜单）带入的选中内容。
   * 只随下一轮提问生效，发完即清空——作为 system 上下文下发，不占用用户消息正文。
   */
  pendingContext: string | null;
  /** 输入框聚焦请求计数：从编辑器唤起面板时递增，面板据此把光标交给输入框 */
  focusTick: number;
  /** 正在「改后重发」的那条用户消息 id；null 表示下一次发送是普通提问 */
  editingId: string | null;
  /** 「优化提问」给出的改写候选（点一条填入输入框） */
  promptIdeas: string[];
  /** 正在向模型请求提问改写 */
  refining: boolean;

  toggle: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setWidth: (w: number) => void;
  loadConfig: () => Promise<void>;
  /** 从库中恢复历史会话（库不可用时回退 localStorage），只在首次打开面板时执行一次 */
  loadSessions: () => Promise<void>;
  setConfig: (c: AiConfig) => void;
  /** 设置/清除下一条提问要附带的选中内容 */
  setPendingContext: (text: string | null) => void;
  send: (text: string, images?: AiImageAttachment[]) => Promise<void>;
  stop: () => void;
  clear: () => void;
  retry: () => Promise<void>;
  quickAction: (kind: AiQuickAction) => Promise<void>;
  /** 归档当前对话并开始新会话 */
  newChat: () => void;
  /** 切换到历史会话（当前对话有内容时先归档） */
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** 重命名历史会话（当前对话的标题由首条提问决定，不参与） */
  renameSession: (id: string, title: string) => void;
  /** 归档 / 取消归档历史会话 */
  setSessionArchived: (id: string, archived: boolean) => void;
  /** 给一条回答打分，再点同向取消 */
  rateMessage: (messageId: string, rating: "up" | "down") => void;
  /** 撤销某条回复里某个动作造成的文档改动（仅编辑器内落地过的可撤销） */
  undoAction: (messageId: string, index: number) => void;
  /** 执行待确认的动作（设置开启「改前确认」后由用户触发） */
  applyAction: (messageId: string, index: number) => Promise<void>;
  /** 忽略待确认的动作 */
  rejectAction: (messageId: string, index: number) => void;
  /** 切换模型档位（会持久化到配置） */
  switchProfile: (id: string) => Promise<void>;
  /** 执行用户在设置里自定义的快捷指令 */
  runQuickAction: (action: AiQuickActionDef) => Promise<void>;
  /** 从上一条被中断的回答接着往下生成 */
  continueGenerate: () => Promise<void>;
  /** 从某条回答重新生成：丢掉它与它之后的消息，用同一个问题再问一次 */
  regenerate: (messageId: string) => Promise<void>;
  /** 改后重发：替换某条提问、丢掉它之后的消息并重新生成 */
  resend: (messageId: string, text: string, images?: AiImageAttachment[]) => Promise<void>;
  /** 把某条提问标记为待修改（面板据此把它填回输入框） */
  startEdit: (messageId: string) => void;
  cancelEdit: () => void;
  /** 从某条消息处分支：当前对话原样归档，之前的内容成为一个新会话 */
  branchFrom: (messageId: string) => void;
  /** 把一条回答另存为文档页面 */
  saveMessageAsPage: (messageId: string) => Promise<void>;
  /** 把一条回答导出成 Markdown 文件 */
  exportMessage: (messageId: string) => Promise<void>;
  /** 让模型把一句提问改写成几条候选 */
  refinePrompt: (text: string) => Promise<void>;
  clearPromptIdeas: () => void;
}

export const useAiStore = create<AiState>()((set, get) => {
  const restored = loadSessionsFromStorage();

  /** 当前流式中的助手消息 id：stop() 据此标记「用户主动中止的这一轮」 */
  let streamingAssistantId: string | null = null;
  /**
   * 轮次序号与被用户停止的轮次集合：停止后迟到的 done 帧不得再自动落地编辑。
   * 必须是每轮独立 token 而不是单个布尔——旧实现里 stop() 后置 true、
   * 下一次发消息重置 false，被停那轮迟到的 done 会绕过取消判定自动写数据。
   */
  let turnSeq = 0;
  const cancelledTurns = new Set<number>();

  /**
   * 当前对话有内容时归档进 sessions（超出上限丢最老），供 newChat / 切换会话复用。
   * archived 为刚落档的会话；pruned 为被挤出上限、需要从库里删除的 id。
   */
  const archiveCurrent = (s: {
    messages: AiMessage[];
    sessions: StoredSession[];
    activeSessionId: string;
    sessionPageId: string | null;
    sessionPageTitle: string | null;
    usageTotal: { prompt: number; completion: number; total: number };
  }): { sessions: StoredSession[]; archived: StoredSession | null; pruned: string[] } => {
    if (s.messages.length === 0) return { sessions: s.sessions, archived: null, pruned: [] };
    const entry: StoredSession = {
      id: s.activeSessionId,
      title: sessionTitle(s.messages),
      updatedAt: Date.now(),
      messages: s.messages,
      pageId: s.sessionPageId,
      pageTitle: s.sessionPageTitle,
      usage: { prompt: s.usageTotal.prompt, completion: s.usageTotal.completion },
    };
    const list = [entry, ...s.sessions];
    const overflow = list.slice(MAX_SESSIONS);
    return {
      // 用户主动归档的会话代表「要留档」，超出条数上限时先裁普通会话
      sessions: list.filter((x, i) => i < MAX_SESSIONS || x.archived === true),
      archived: entry,
      pruned: overflow.filter((x) => x.archived !== true).map((x) => x.id),
    };
  };

  /** 会话快照落盘（流式增量不触发，只在轮次结束 / 显式操作时调用） */
  /** 跨会话 token 累计：库不可用时清掉即可，用量条是锦上添花，不该弹错打扰 */
  const fetchUsage = () => {
    void aiUsageSummary()
      .then((v) => set({ usageSummary: v }))
      .catch(() => set({ usageSummary: null }));
  };

  /** localStorage 兜底：只在落库失败时用；配额溢出则丢一半最老的归档重试一次 */
  const writeLocal = (active: StoredSession | null, sessions: StoredSession[]) => {
    const activeId = get().activeSessionId;
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify({ activeId, sessions, active }));
    } catch {
      try {
        localStorage.setItem(
          SESSIONS_KEY,
          JSON.stringify({
            activeId,
            sessions: sessions.slice(0, Math.floor(MAX_SESSIONS / 2)),
            active,
          }),
        );
      } catch (e) {
        logger.warn("ai sessions persist failed", e);
      }
    }
  };

  /** 当前进行中的对话快照；没有消息时为 null（库里不存在空会话行） */
  const activeSnapshot = (): StoredSession | null => {
    const s = get();
    if (s.messages.length === 0) return null;
    return {
      id: s.activeSessionId,
      title: sessionTitle(s.messages),
      updatedAt: Date.now(),
      messages: s.messages,
      pageId: s.sessionPageId,
      pageTitle: s.sessionPageTitle,
      usage: { prompt: s.usageTotal.prompt, completion: s.usageTotal.completion },
    };
  };

  // 默认落库：localStorage 只有约 5MB 配额，长对话写满后会被迫丢弃历史；落库则没有这个上限。
  // 按条 upsert 而非整表覆盖：单条写失败不至于把其它会话一起清掉。
  const saveSession = (session: StoredSession) => {
    void aiSessionSave(toSessionRow(session))
      .then(fetchUsage)
      .catch((e: unknown) => {
        logger.warn("ai session save to db failed, fallback to localStorage", e);
        writeLocal(activeSnapshot(), get().sessions);
      });
  };

  const dropSessions = (ids: string[]) => {
    if (ids.length === 0) return;
    const ops = ids.map((id) => aiSessionDelete(id).catch((e: unknown) => logger.warn("ai session delete failed", e)));
    // 删除影响累计用量：等写请求落地再重取，否则拿到的还是删之前的数
    void Promise.allSettled(ops).then(fetchUsage);
  };

  const persistSessions = () => {
    const active = activeSnapshot();
    if (active) saveSession(active);
  };

  /** 本地（localStorage）那份老数据直接充当当前状态：库不可用、或库与本地都空时走这里 */
  const applyLocal = (local: LocalSessions) =>
    set({
      sessions: local.sessions,
      activeSessionId: local.activeId,
      messages: local.active?.messages ?? [],
      sessionPageId: local.active?.pageId ?? null,
      sessionPageTitle: local.active?.pageTitle ?? null,
      usageTotal: sessionUsageTotal(local.active?.usage),
      sessionsLoaded: true,
    });

  /**
   * 一次性导入老会话：ai_sessions 的建表迁移在 0.8.24 之前从未生效，历史只存在 localStorage。
   * 库空而本地有货时先写进库，全部成功才清掉本地副本 —— 否则下一次启动库里已经有当前会话的行，
   * 本地那份归档就再也读不到了（看起来像用户的历史会话凭空消失）。
   * 返回 false 表示没导成功，调用方继续沿用本地那份，下次启动还会重试。
   */
  const importLocalSessions = async (pending: StoredSession[]): Promise<boolean> => {
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

  /** 当前配置的最大上下文字符数 */
  const maxChars = () => {
    const configured = get().config?.max_chars;
    return configured && configured > 0 ? configured : DEFAULT_MAX_CHARS;
  };

  /**
   * system prompt：有可编辑文档时下发编辑协议 + 当前文档上下文（AI 自主修改的基础），
   * 没有文档时退化为纯问答，避免模型凭空产出编辑指令。
   */
  const systemMessage = (): AiChatMessage => {
    const bridge = getAiEditor();
    if (!bridge) return { role: "system", content: CHAT_ONLY_SYSTEM_PROMPT };
    const limit = maxChars();
    return {
      role: "system",
      content: buildEditSystemPrompt({
        title: bridge.getPageTitle(),
        selection: bridge.getSelectionText().slice(0, limit),
        pageText: bridge.getPageText().slice(0, limit),
      }),
    };
  };

  /** 组装发给服务端的消息：system + 参考文档 + 历史对话（排除空的助手占位） */
  const requestMessages = (assistantId: string, referenceContext = ""): AiChatMessage[] => {
    const history = get()
      .messages.filter((m) => m.id !== assistantId && (m.content.trim().length > 0 || m.images?.length))
      .map((m) => ({
        role: m.role,
        content: m.content,
        // 只给路径：图片字节由 Rust 在发请求前按 assets 相对路径读出内联
        ...(m.images?.length ? { images: m.images.map((i) => ({ path: i.path })) } : {}),
      }));
    // 长对话防超限：按估算 token 从最新往前收进预算，放不下的早期轮次丢弃
    const kept: AiChatMessage[] = [];
    let budget = HISTORY_TOKEN_BUDGET;
    for (let i = history.length - 1; i >= 0 && kept.length < HISTORY_MAX_MESSAGES; i--) {
      const m = history[i];
      const cost = estimateTokens(m.content);
      if (cost > budget) {
        // 一条都放不下（如首轮就粘贴长文）：保最新一条的尾部
        if (kept.length === 0) kept.push({ role: m.role, content: tailTokens(m.content, HISTORY_TOKEN_BUDGET) });
        break;
      }
      budget -= cost;
      kept.unshift(m);
    }
    const dropped = history.length - kept.length;
    // 编辑器带入的选中内容：单独一条 system 下发，不塞进用户消息正文（气泡里不必重复一大段原文）
    const pending = get().pendingContext?.trim();
    return [
      systemMessage(),
      ...(referenceContext ? [{ role: "system" as const, content: referenceContext }] : []),
      ...(pending ? [{ role: "system" as const, content: `【用户在文档中选中的内容】\n${pending}` }] : []),
      // 发生截断时显式告知模型，免得它把「从这里开始」误当成整段对话的开头
      ...(dropped > 0
        ? [
            {
              role: "system" as const,
              content: `【注意】受上下文预算限制，本对话最早的 ${dropped} 条消息已被截断、未随本次请求发送；需要更早的信息时请让用户补充。`,
            },
          ]
        : []),
      ...kept,
    ];
  };

  /**
   * 用户消息里 `@文件名` 引用的文档 → 参考上下文。
   * 短文档整篇给出；长文档先按问题检索相关片段，检索不到才回退整篇截断并写明截断了多少，
   * 避免模型拿着被静默砍掉的上下文作答。
   * 引用名解析不到（改名/删除/未同步）时静默跳过，不影响本轮提问。
   */
  const buildReferenceContext = async (): Promise<string> => {
    const lastUser = [...get().messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return "";
    const list = flattenTree(useWorkspaceStore.getState().tree);
    if (list.length === 0) return "";
    const refs = parseMentions(
      lastUser.content,
      list.map((v) => ({ id: v.id, name: v.name })),
    );
    if (refs.length === 0) return "";
    const limit = maxChars();
    // 检索词取用户问题的正文（去掉 @ 提及的文档名，它们不是查询意图）
    const query = lastUser.content.replace(/@\S+/g, " ").trim() || lastUser.content;
    const parts: string[] = [];
    for (const ref of refs) {
      try {
        const raw = await documentApi.get(ref.id);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as JSONContent | JSONContent[];
        const doc: JSONContent = Array.isArray(parsed) ? { type: "doc", content: parsed } : parsed;
        const md = jsonToMarkdown(doc).trim();
        if (!md) continue;
        if (md.length <= limit) {
          parts.push(`### ${ref.name}\n${md}`);
          continue;
        }
        // 超长：优先按问题取相关片段
        const snippets = await docSearchSnippets(ref.id, query, 8).catch(() => [] as string[]);
        if (snippets.length > 0) {
          const body = snippets.join("\n…\n").slice(0, limit);
          parts.push(`### ${ref.name}（长文档，已按问题检索出 ${snippets.length} 个相关片段）\n${body}`);
        } else {
          const cut = md.length - limit;
          parts.push(
            `### ${ref.name}（长文档，未命中相关片段，仅取前 ${limit} 字，已截断 ${cut} 字）\n${md.slice(0, limit)}`,
          );
        }
      } catch (e) {
        logger.error("ai reference load failed", ref.id, e);
      }
    }
    if (parts.length === 0) return "";
    return `【用户 @ 引用的文档】\n${parts.join("\n\n")}`;
  };

  /** 失败时丢弃空的助手占位（保留有内容的半截回答），错误单独存供重试 */
  const dropEmptyAssistant = (assistantId: string) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== assistantId || m.content.trim().length > 0) }));

  /** 定位失败原因 → 界面文案 */
  const LOCATE_REASON: Record<LocateFailure["reason"], MessageKey> = {
    no_doc: "ai.noPage",
    heading_not_found: "ai.locateHeadingNotFound",
    text_not_found: "ai.locateTextNotFound",
    protected_heading: "ai.locateProtectedHeading",
    bad_structure: "ai.locateBlockedByLock",
  };

  /** 当前编辑器桥接与正在打开的页面（apply_edit 不带 view_id 时的落点） */
  const editorTarget = () => ({
    bridge: getAiEditor(),
    currentId: useWorkspaceStore.getState().currentViewId,
  });

  /** 指定视图的落地桥接：主栏/副栏打开中的页面一律就地走编辑器事务；未打开时返回 null 走 JSON 直写 */
  const bridgeFor = (
    view_id: string | undefined,
    currentBridge: ReturnType<typeof getAiEditor>,
    currentId: string | null,
  ) => {
    if (!view_id) return currentBridge;
    if (currentBridge && currentId === view_id) return currentBridge;
    return getAiEditorForView(view_id);
  };

  /**
   * 对非当前页做定位编辑：save=false 只演练一遍（取 diff 用的改前原文、判断能不能定位到）。
   * JSON 路径没有编辑器事务栈，这样落地的改动无法在界面上「撤销」。
   */
  const editOnPage = async (
    node: ViewNode,
    op: AiEditOp,
    markdown: string,
    anchor: AiEditAnchor | undefined,
    save: boolean,
  ): Promise<{ ok: boolean; before: string; reason?: string }> => {
    try {
      const raw = await documentApi.get(node.id);
      const doc: JSONContent = raw
        ? asDoc(JSON.parse(raw) as JSONContent | JSONContent[])
        : { type: "doc", content: [] };
      const result = applyEditToDocJson(doc, op, markdown, anchor);
      if (!result.ok) return { ok: false, before: "", reason: t(LOCATE_REASON[result.reason]) };
      if (save) await documentApi.save(node.id, JSON.stringify({ ...doc, content: result.content }));
      return { ok: true, before: result.before };
    } catch (e) {
      logger.error("ai cross-page edit failed", node.id, e);
      return { ok: false, before: "", reason: e instanceof Error ? e.message : String(e) };
    }
  };

  /** 动作落点与可行性预览：blocked 非空表示这条动作根本执行不了 */
  const previewAction = async (call: AiWriteCall): Promise<{ before: string; pageName: string; blocked?: string }> => {
    if (call.tool !== "apply_edit") {
      const ref =
        call.tool === "create_page"
          ? call.args.parent_page
          : call.tool === "set_page_title"
            ? call.args.page
            : call.args.database;
      if (!ref) return { before: "", pageName: "" };
      const node = resolvePage(ref);
      if (!node) return { before: "", pageName: "", blocked: t("ai.toolPageNotFound", { ref }) };
      return { before: "", pageName: node.name };
    }
    const { op, content, anchor, view_id } = call.args;
    const { bridge, currentId } = editorTarget();
    const target = bridgeFor(view_id, bridge, currentId);
    if (target) {
      return { before: target.getEditTargetText(op, anchor), pageName: target.getPageTitle() };
    }
    if (!view_id) return { before: "", pageName: "", blocked: t("ai.noEditor") };
    const node = resolvePage(view_id);
    if (!node) return { before: "", pageName: "", blocked: t("ai.toolPageNotFound", { ref: view_id }) };
    const dry = await editOnPage(node, op, content, anchor, false);
    return { before: dry.before, pageName: node.name, ...(dry.reason ? { blocked: dry.reason } : {}) };
  };

  /** 真正执行一个动作：当前页走编辑器事务（可撤销），其它页面与库写入走各自路径 */
  const landAction = async (rec: AiActionRecord): Promise<AiActionRecord> => {
    const call = rec.call;
    if (!call) return { ...rec, state: "unavailable" };
    if (call.tool === "apply_edit") {
      const { op, content, anchor, view_id } = call.args;
      const { bridge, currentId } = editorTarget();
      // 打开中的页面（含分栏副栏）必须走编辑器事务：JSON 直写会被该实例自动保存覆盖回去
      const target = bridgeFor(view_id, bridge, currentId);
      if (target) {
        const result = target.applyEdit(op, content, anchor);
        return result.applied
          ? { ...rec, state: "applied", revert: result.revert }
          : { ...rec, state: "unavailable", detail: result.reason ?? t("ai.editNotApplied") };
      }
      if (!view_id) return { ...rec, state: "unavailable", detail: t("ai.noEditor") };
      const node = resolvePage(view_id);
      if (!node) return { ...rec, state: "unavailable", detail: t("ai.toolPageNotFound", { ref: view_id }) };
      const done = await editOnPage(node, op, content, anchor, true);
      if (done.ok) return { ...rec, state: "applied", pageName: node.name };
      return { ...rec, state: "unavailable", pageName: node.name, detail: done.reason };
    }
    const outcome = await runWriteAction(call);
    if (outcome.ok) return { ...rec, state: "applied", detail: outcome.detail };
    return { ...rec, state: "unavailable", detail: outcome.detail };
  };

  /** 一条动作先预览、再按设置决定停在待确认还是立即落地（confirm_edit 开启时永不自动写） */
  const planAction = async (call: AiWriteCall, turnId: number): Promise<AiActionRecord> => {
    const preview = await previewAction(call);
    const record: AiActionRecord = {
      tool: call.tool,
      call,
      op: call.tool === "apply_edit" ? call.args.op : null,
      summary: summaryOf(call),
      content: contentOf(call),
      // 改前原文：即便直接落地也留一份，之后随时可以「查看改动」
      before: preview.before,
      pageName: preview.pageName,
      state: "unavailable",
      ...(preview.blocked ? { detail: preview.blocked } : {}),
    };
    if (preview.blocked) return record;
    // 用户按「停止」后迟到的 done 帧不能替用户写数据；与开启确认一样停在待确认
    if (cancelledTurns.has(turnId) || get().config?.confirm_edit) return { ...record, state: "pending" };
    return await landAction(record);
  };

  /** 收尾：正文剥掉指令块，写动作逐条预览落地；检索达到轮次上限时在正文后说明 */
  const finalizeAssistant = async (
    assistantId: string,
    turnId: number,
    full: string,
    writes: AiWriteCall[],
    malformed: boolean,
    droppedRetrievals: number,
  ) => {
    const display = extractCalls(full).display;
    const note = droppedRetrievals > 0 ? `\n\n${t("ai.searchRoundLimit", { max: MAX_AGENT_ROUNDS })}` : "";
    if (writes.length === 0) {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: (display.trim() || full) + note,
                // 指令块有问题：正文已剥掉坏块，这里只留一张提示卡片（没有落地动作，也就没有撤销）
                ...(malformed ? { actions: [invalidActionRecord()] } : {}),
              }
            : m,
        ),
      }));
      return;
    }
    const records: AiActionRecord[] = [];
    if (malformed) records.push(invalidActionRecord());
    for (const call of writes) records.push(await planAction(call, turnId));
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              // 正文为空时用第一条动作的说明兜底，保证这条消息留在后续对话上下文里
              content: (display.trim() || records[0].summary) + note,
              actions: records,
            }
          : m,
      ),
    }));
  };

  /**
   * 跑一轮模型请求：raw 累积模型原始输出，state 里只放「去掉指令块」的展示文本。
   * 返回全量文本、函数调用与本轮结局，供 runStream 编排 agent 循环。
   */
  const streamRound = async (
    assistantId: string,
    outgoing: AiChatMessage[],
  ): Promise<{
    full: string;
    refs: AiToolCallRaw[];
    cancelled: boolean;
    failed: { message: string; code: string | null } | null;
  }> => {
    let raw = "";
    let full = "";
    let refs: AiToolCallRaw[] = [];
    let cancelled = false;
    let failed: { message: string; code: string | null } | null = null;
    // 流式节流：每个增量都 set 会重建整条消息数组并重解析 Markdown，长回答会掉帧。
    // 把约 60ms 内的增量合并成一帧提交（约 16 次/秒，肉眼仍是连贯的打字效果）。
    let pendingDelta = "";
    let pendingReasoning = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pendingDelta && !pendingReasoning) return;
      const r = pendingReasoning;
      pendingDelta = "";
      pendingReasoning = "";
      // 正文一律由 raw 重算：指令块开始之后的增量不能显示出来
      const display = hideEditBlock(raw);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: display } : m)),
        reasoning: r ? s.reasoning + r : s.reasoning,
      }));
    };
    const flushNow = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    };
    // 工具定义只在服务商支持函数调用时下发；不支持时模型走文本协议块，能力等价
    const tools = get().config?.use_tools ? aiToolSpecs() : undefined;
    await aiChat(
      outgoing,
      (ev: AiChatEvent) => {
        if (ev.type === "chunk") {
          raw += ev.delta;
          pendingDelta += ev.delta;
          flushTimer ??= setTimeout(flush, 60);
        } else if (ev.type === "reasoning") {
          // 推理型模型的思考增量：单独累积，只用于展示，不写进助手消息
          pendingReasoning += ev.delta;
          flushTimer ??= setTimeout(flush, 60);
        } else if (ev.type === "done") {
          // 收尾前先把没来得及提交的增量补上，否则会被 finalize 的结果覆盖
          flushNow();
          full = ev.full || raw;
          refs = ev.tool_calls ?? [];
          const u = ev.usage;
          if (u) {
            set((s) => ({
              usage: addUsage(s.usage, u),
              usageTotal: {
                prompt: s.usageTotal.prompt + (u.prompt_tokens ?? 0),
                completion: s.usageTotal.completion + (u.completion_tokens ?? 0),
                total: s.usageTotal.total + (u.total_tokens ?? 0),
              },
            }));
          }
        } else if (ev.message === "cancelled") {
          // 用户主动「停止」时 Rust 会回 cancelled：不算错误，保留已生成的部分内容
          flushNow();
          cancelled = true;
        } else {
          flushNow();
          failed = { message: ev.message, code: ev.code ?? null };
        }
      },
      tools,
    );
    return { full: full || raw, refs, cancelled, failed };
  };

  /**
   * agent 循环：模型请求 → 若它要求只读检索则本机执行、把结果喂回去再来一轮 →
   * 收敛后统一落地写动作（改文档 / 建页 / 改标题 / 加表行）。
   * 循环放在前端而不是 Rust：页面树、文档、数据库与编辑器的权威状态都在前端。
   */
  const runStream = async (assistantId: string) => {
    streamingAssistantId = assistantId;
    const turnId = ++turnSeq;
    // usage 是「本轮合计」：先清零，多轮往返才不会被上一轮的用量掺进来
    set({ usage: null });
    // @ 引用的文档要先读盘转文本，再随 system 一起下发
    let outgoing = requestMessages(assistantId, await buildReferenceContext());
    // 选中内容只随本轮生效：消息组装完就清掉，下一轮不再重复带
    if (get().pendingContext) set({ pendingContext: null });
    const writes: AiWriteCall[] = [];
    let lastFull = "";
    let malformed = false;
    let droppedRetrievals = 0;
    let cancelled = false;
    let failed: { message: string; code: string | null } | null = null;
    try {
      for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
        const result = await streamRound(assistantId, outgoing);
        lastFull = result.full;
        cancelled = result.cancelled;
        failed = result.failed;
        if (cancelled || failed) break;
        const { items, malformed: bad } = collectCalls(result.refs, result.full);
        malformed = malformed || bad;
        for (const x of items) if (isWriteCall(x.call)) writes.push(x.call);
        const retrievals = items.filter((x) => isRetrievalCall(x.call));
        if (retrievals.length === 0) break;
        // 往返已到上限：不再执行检索（结果没机会进答案），只在正文后说明一句
        if (round + 1 >= MAX_AGENT_ROUNDS) {
          droppedRetrievals = retrievals.length;
          break;
        }
        set({ retrieving: true });
        const toolMode = !!get().config?.use_tools;
        const limit = maxChars();
        const toolRefs: AiToolCallRef[] = [];
        const toolMsgs: AiChatMessage[] = [];
        const plain: { tool: string; result: string }[] = [];
        for (const [i, x] of retrievals.entries()) {
          const call = x.call as RetrievalCall;
          // 函数调用回灌要带原 id；文本协议块没有 id，按序号造一个配套的（assistant 消息里一并声明）
          const id = x.id || `tcall_${round}_${i}`;
          const output = await runRetrievalCall(call.tool, call.args, limit);
          toolRefs.push({ id, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } });
          if (toolMode) toolMsgs.push({ role: "tool", content: output, tool_call_id: id });
          else plain.push({ tool: call.tool, result: output });
        }
        set({ retrieving: false });
        outgoing = [
          ...outgoing,
          { role: "assistant", content: result.full, ...(toolMode ? { tool_calls: toolRefs } : {}) },
          ...(toolMode ? toolMsgs : [{ role: "system" as const, content: retrievalResultMessage(plain) }]),
        ];
        // 下一轮的答案才是给用户看的：本轮文本（多半只是「我先查一下」）清掉，免得两轮内容叠在一起
        set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
      }
      if (failed) {
        set({ error: failed.message, errorCode: failed.code });
        dropEmptyAssistant(assistantId);
      } else if (!cancelled) {
        await finalizeAssistant(assistantId, turnId, lastFull, writes, malformed, droppedRetrievals);
      }
    } catch (e) {
      // 起手就失败（未配置 / 命令报错）：没有归类码，界面按通用错误处理
      set({ error: aiErrorText(e), errorCode: null });
      dropEmptyAssistant(assistantId);
    } finally {
      set({ streaming: false, retrieving: false });
      streamingAssistantId = null;
      cancelledTurns.delete(turnId);
      // 一轮结束（含失败/取消）后落盘，流式增量期间不写
      persistSessions();
    }
  };

  /** 库里存的用量 → 面板用的累计三元组（老会话没单独记 total，用输入+输出兜底） */
  const sessionUsageTotal = (u?: SessionUsage) => ({
    prompt: u?.prompt ?? 0,
    completion: u?.completion ?? 0,
    total: (u?.prompt ?? 0) + (u?.completion ?? 0),
  });

  return {
    open: false,
    width: loadWidth(),
    messages: restored.active?.messages ?? [],
    sessions: restored.sessions,
    activeSessionId: restored.active?.id ?? restored.activeId,
    reasoning: "",
    streaming: false,
    retrieving: false,
    error: null,
    errorCode: null,
    sessionPageId: null,
    sessionPageTitle: null,
    sessionsLoaded: false,
    usage: null,
    usageTotal: sessionUsageTotal(restored.active?.usage),
    usageSummary: null,
    config: null,
    configLoaded: false,
    pendingContext: null,
    focusTick: 0,
    editingId: null,
    promptIdeas: [],
    refining: false,

    toggle: () => set((s) => ({ open: !s.open })),
    // 打开面板的同时请求聚焦输入框：编辑器里点「问 AI」后可以立刻开始打字
    openPanel: () => set((s) => ({ open: true, focusTick: s.focusTick + 1 })),
    closePanel: () => set({ open: false }),
    setWidth: (w) => {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
      set({ width });
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(width));
      } catch {
        /* localStorage 不可用时静默降级 */
      }
    },

    loadConfig: async () => {
      try {
        const config = await aiGetConfig();
        set({ config, configLoaded: true });
      } catch (e) {
        set({ configLoaded: true, error: aiErrorText(e) });
      }
    },

    // 历史会话优先从库里读（localStorage 只有约 5MB 配额）；库为空或不可用时再用本地老数据
    loadSessions: async () => {
      if (get().sessionsLoaded) return;
      const local = loadSessionsFromStorage();
      let rows: AiSessionRow[];
      try {
        rows = await aiSessionList();
      } catch (e) {
        logger.warn("ai sessions load from db failed, fallback to localStorage", e);
        applyLocal(local);
        return;
      }
      // 库按 updated_at 降序返回。普通会话取到条数上限即止，归档的不受上限裁剪——
      // 那是用户明确要留档的，历史搜索正是为它们准备的。
      const all: StoredSession[] = [];
      let normal = 0;
      for (const r of rows) {
        const s = fromSessionRow(r);
        if (!s) continue;
        if (s.archived) all.push(s);
        else if (normal++ < MAX_SESSIONS + 1) all.push(s);
      }
      if (all.length === 0) {
        const pending = [local.active, ...local.sessions].filter((s): s is StoredSession => s !== null);
        // 导入失败（或本地本来就没会话）就沿用本地那份，下次启动还会重试
        if (pending.length === 0 || !(await importLocalSessions(pending))) {
          applyLocal(local);
          return;
        }
        // 保持本地那份的当前会话在第一位，切过来还是用户正在看的那段对话
        all.push(...pending.slice(0, MAX_SESSIONS + 1));
      }
      // 当前对话取最近一条未归档的；全被归档了就退回最近那条
      const fresh = all.findIndex((x) => !x.archived);
      const active = all[fresh < 0 ? 0 : fresh];
      set({
        messages: active.messages,
        activeSessionId: active.id,
        sessions: all.filter((x) => x.id !== active.id),
        sessionPageId: active.pageId ?? null,
        sessionPageTitle: active.pageTitle ?? null,
        usageTotal: sessionUsageTotal(active.usage),
        sessionsLoaded: true,
      });
      fetchUsage();
    },
    setConfig: (config) => set({ config, configLoaded: true }),
    setPendingContext: (text) => set({ pendingContext: text }),

    send: async (text, images) => {
      const content = text.trim();
      // 只带图、不打字也算一次提问；两者皆空才忽略
      if ((!content && !images?.length) || get().streaming) return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      // 会话首条消息：记下发起时所在的页面，之后历史会话列表能标注它的上下文来源
      const pageRef = get().messages.length === 0 ? currentPageRef() : null;
      set((s) => ({
        open: true,
        error: null,
        errorCode: null,
        reasoning: "",
        streaming: true,
        promptIdeas: [],
        // 普通提问（含快捷动作）会往列表追加内容，此前「改后重发」的目标不再有效
        editingId: null,
        messages: [
          ...s.messages,
          { id: newId(), role: "user", content, ...(images?.length ? { images } : {}) },
          assistant,
        ],
        ...(pageRef ? { sessionPageId: pageRef.id, sessionPageTitle: pageRef.name } : {}),
      }));
      // 用户消息先落盘，流式中途崩溃也不丢提问
      persistSessions();
      await runStream(assistant.id);
    },

    stop: () => {
      // 标记本轮被用户停止：之后即便 Rust 尾帧（done）晚一步到达，也不会自动落地编辑。
      // 只标记「当时正在流的那一轮」，不影响用户随后立刻发起的新轮
      if (streamingAssistantId) cancelledTurns.add(turnSeq);
      aiCancel().catch(() => undefined);
      set({ streaming: false });
    },

    clear: () => {
      const hadContent = get().messages.length > 0;
      const oldId = get().activeSessionId;
      set({
        messages: [],
        reasoning: "",
        error: null,
        errorCode: null,
        editingId: null,
        promptIdeas: [],
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      // 清空即销毁这一会话：按 id 删除它的库行，而不是留下空壳
      if (hadContent) dropSessions([oldId]);
    },

    /** 归档当前对话并开始新会话 */
    newChat: () => {
      const { sessions, archived, pruned } = archiveCurrent(get());
      set({
        sessions,
        messages: [],
        reasoning: "",
        error: null,
        errorCode: null,
        editingId: null,
        promptIdeas: [],
        // 新会话的关联页面等第一条消息时再定
        sessionPageId: null,
        sessionPageTitle: null,
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
        activeSessionId: newId(),
      });
      if (archived) saveSession(archived);
      dropSessions(pruned);
    },

    /** 切换到历史会话（当前对话有内容时先归档；流式进行中不允许切） */
    switchSession: (id) => {
      const s = get();
      if (s.streaming) return;
      const target = s.sessions.find((x) => x.id === id);
      if (!target) return;
      const rest = s.sessions.filter((x) => x.id !== id);
      const archived = archiveCurrent({ ...s, sessions: rest });
      set({
        sessions: archived.sessions,
        messages: target.messages,
        activeSessionId: target.id,
        sessionPageId: target.pageId ?? null,
        sessionPageTitle: target.pageTitle ?? null,
        reasoning: "",
        error: null,
        errorCode: null,
        // 换会话后消息列表整个换掉，待修改的提问 id 不再指向任何消息
        editingId: null,
        promptIdeas: [],
        // 累计用量按会话统计：切过去先接上它自己那份历史用量，本轮再往上累加
        usage: null,
        usageTotal: sessionUsageTotal(target.usage),
      });
      if (archived.archived) saveSession(archived.archived);
      dropSessions(archived.pruned);
    },

    deleteSession: (id) => {
      if (get().streaming) return;
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
      dropSessions([id]);
    },

    // 改名与归档都只动历史列表里的那一行：整行 upsert，不需要额外的命令
    renameSession: (id, rawTitle) => {
      const title = rawTitle.trim().slice(0, 60);
      const target = get().sessions.find((x) => x.id === id);
      if (!title || !target || target.title === title) return;
      const next = { ...target, title };
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? next : x)) }));
      saveSession(next);
    },

    setSessionArchived: (id, archived) => {
      const target = get().sessions.find((x) => x.id === id);
      if (!target || target.archived === archived) return;
      const next = { ...target, archived };
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? next : x)) }));
      saveSession(next);
    },

    // 评分写在消息上，随会话整条落库；点同一次即取消（rating 置 undefined，序列化时自然消失）
    rateMessage: (messageId, rating) => {
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          return m.rating === rating ? { ...m, rating: undefined } : { ...m, rating };
        }),
      }));
      persistSessions();
    },

    retry: async () => {
      if (get().streaming) return;
      const msgs = [...get().messages];
      // 去掉尾部失败/空的助手消息，回到最后一条用户消息重发
      while (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant" && !msgs[msgs.length - 1].content.trim()) {
        msgs.pop();
      }
      if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set({
        messages: [...msgs, assistant],
        reasoning: "",
        streaming: true,
        error: null,
        errorCode: null,
      });
      await runStream(assistant.id);
    },

    // 快捷动作：总结当前页取整页纯文本（按 max_chars 截断）；其余三个用选中文本
    quickAction: async (kind) => {
      const bridge = getAiEditor();
      const limit = maxChars();
      // 续写不需要选中：整页上下文已随 system prompt 下发，只要文档在就行
      if (kind === "continue") {
        if (!bridge) {
          toast.error(t("ai.noPage"));
          return;
        }
        await get().send(t(QUICK_PROMPT_KEY[kind]));
        return;
      }
      let content: string;
      if (kind === "summarize") {
        const page = bridge?.getPageText().trim() ?? "";
        if (!page) {
          toast.error(t("ai.noPage"));
          return;
        }
        content = page.slice(0, limit);
      } else {
        const selection = bridge?.getSelectionText().trim() ?? "";
        if (!selection) {
          toast.error(t("ai.noSelection"));
          return;
        }
        content = selection;
      }
      await get().send(t(QUICK_PROMPT_KEY[kind], { content }));
    },

    // 撤销 AI 的自动改写：按改前快照精确回滚，撤不动时明确告知而不是静默撤掉用户的编辑
    undoAction: (messageId, index) => {
      const bridge = getAiEditor();
      const rec = get().messages.find((m) => m.id === messageId)?.actions?.[index];
      if (!bridge || !rec?.revert) return;
      if (!bridge.undoAiEdit(rec.revert)) {
        toast.error(t("ai.undoFailed"));
        return;
      }
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.actions
            ? { ...m, actions: m.actions.map((a, i) => (i === index ? { ...a, undone: true } : a)) }
            : m,
        ),
      }));
      persistSessions();
    },

    // 用户在 diff 预览后点「应用」：这才真正写数据（文档 / 页面 / 表格）
    applyAction: async (messageId, index) => {
      const s = get();
      const msg = s.messages.find((m) => m.id === messageId);
      const rec = msg?.actions?.[index];
      if (!msg || rec?.state !== "pending") return;
      const landed = await landAction(rec);
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId && m.actions ? { ...m, actions: m.actions.map((a, i) => (i === index ? landed : a)) } : m,
        ),
      }));
      if (landed.state === "applied") toast.success(t("ai.actionAppliedToast"));
      persistSessions();
    },

    rejectAction: (messageId, index) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.actions
            ? {
                ...m,
                actions: m.actions.map((a, i) =>
                  i === index && a.state === "pending" ? { ...a, state: "rejected" } : a,
                ),
              }
            : m,
        ),
      }));
      persistSessions();
    },

    // 切换档位：只改 active_profile，其余配置原样回传（apiKey 传 null 表示不改动已保存的 Key）
    switchProfile: async (id) => {
      const c = get().config;
      if (!c) return;
      try {
        await aiSaveConfig({
          enabled: c.enabled,
          provider: c.provider,
          protocol: c.protocol,
          baseUrl: c.base_url,
          model: c.model,
          maxChars: c.max_chars,
          confirmEdit: c.confirm_edit,
          temperature: c.temperature,
          maxTokens: c.max_tokens,
          systemPrompt: c.system_prompt,
          profiles: c.profiles,
          activeProfile: id,
          quickActions: c.quick_actions,
          useTools: c.use_tools,
          priceInput: c.price_input,
          priceOutput: c.price_output,
          apiKey: null,
        });
        set({ config: await aiGetConfig() });
      } catch (e) {
        logger.error("ai switch profile failed", e);
        toast.error(t("ai.errorPrefix", { message: String(e) }));
      }
    },

    // 自定义快捷指令：按 scope 取文本填进模板的 {content} 占位符
    runQuickAction: async (action) => {
      const bridge = getAiEditor();
      let content = "";
      if (action.scope === "selection") {
        content = bridge?.getSelectionText().trim() ?? "";
        if (!content) {
          toast.error(t("ai.noSelection"));
          return;
        }
      } else if (action.scope === "page") {
        content = (bridge?.getPageText().trim() ?? "").slice(0, maxChars());
        if (!content) {
          toast.error(t("ai.noPage"));
          return;
        }
      }
      const prompt = action.prompt.includes("{content}")
        ? action.prompt.replace("{content}", content)
        : content
          ? `${action.prompt}\n\n${content}`
          : action.prompt;
      await get().send(prompt);
    },

    // 继续生成：半截回答留在上下文里再问一次，模型会接着往下写（不重复已有内容）
    continueGenerate: async () => {
      const s = get();
      const total = s.messages.length;
      if (s.streaming || total === 0) return;
      if (s.messages[total - 1].role !== "assistant") return;
      await s.send(t("ai.continueGeneratePrompt"));
    },

    regenerate: async (messageId) => {
      const s = get();
      if (s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      // 只重跑助手回答，且它前面得有可供重问的提问
      if (i < 0 || s.messages[i].role !== "assistant" || !s.messages.slice(0, i).some((m) => m.role === "user")) return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set({
        messages: [...s.messages.slice(0, i), assistant],
        editingId: null,
        promptIdeas: [],
        reasoning: "",
        error: null,
        errorCode: null,
        streaming: true,
      });
      await runStream(assistant.id);
    },

    resend: async (messageId, text, images) => {
      const content = text.trim();
      const s = get();
      if ((!content && !images?.length) || s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      if (i < 0 || s.messages[i].role !== "user") return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set({
        editingId: null,
        promptIdeas: [],
        messages: [...s.messages.slice(0, i), { ...s.messages[i], content, ...(images ? { images } : {}) }, assistant],
        reasoning: "",
        error: null,
        errorCode: null,
        streaming: true,
      });
      persistSessions();
      await runStream(assistant.id);
    },

    // 改后重发的入口：只标记目标提问，正文由面板填回输入框，用户改完再发送
    startEdit: (messageId) => {
      const s = get();
      if (s.streaming) return;
      const msg = s.messages.find((m) => m.id === messageId);
      if (msg?.role === "user") set({ editingId: messageId, promptIdeas: [] });
    },
    cancelEdit: () => set({ editingId: null }),

    branchFrom: (messageId) => {
      const s = get();
      if (s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      if (i < 0) return;
      const prefix = s.messages.slice(0, i + 1);
      // 原对话整段归档保留，分支是一个新会话，两条线互不影响
      const { sessions, archived, pruned } = archiveCurrent(s);
      const branch: StoredSession = {
        id: newId(),
        title: sessionTitle(prefix),
        updatedAt: Date.now(),
        messages: prefix,
        pageId: s.sessionPageId,
        pageTitle: s.sessionPageTitle,
      };
      set({
        sessions,
        messages: prefix,
        activeSessionId: branch.id,
        editingId: null,
        promptIdeas: [],
        reasoning: "",
        error: null,
        errorCode: null,
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      if (archived) saveSession(archived);
      dropSessions(pruned);
      saveSession(branch);
    },

    saveMessageAsPage: async (messageId) => {
      const msg = get().messages.find((m) => m.id === messageId);
      const content = msg?.content.trim();
      if (!content) return;
      try {
        const outcome = await runWriteAction({
          tool: "create_page",
          args: { title: pageTitleFrom(content), content },
        });
        if (outcome.ok) toast.success(outcome.detail);
        else toast.error(outcome.detail);
      } catch (e) {
        toast.error(aiErrorText(e));
      }
    },

    exportMessage: async (messageId) => {
      const msg = get().messages.find((m) => m.id === messageId);
      const content = msg?.content.trim();
      if (!content) return;
      // 走 Rust 侧 write_text_file：路径由保存对话框授权，与页面/CSV 导出同一口径
      const target = await save({
        defaultPath: `${pageTitleFrom(content).replace(/[\\/:*?"<>|]/g, "-")}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return;
      try {
        await invoke("write_text_file", { path: target, content });
        toast.success(t("settings.exportedFile", { path: target }));
      } catch (e) {
        toast.error(aiErrorText(e));
      }
    },

    refinePrompt: async (text) => {
      const question = text.trim();
      if (!question || get().streaming || get().refining) return;
      set({ refining: true, promptIdeas: [] });
      // 改写是一次性请求，不进对话：错误单独收集，别把面板的 error 状态污染成「这一轮失败」
      const state: { full: string; failed: string | null } = { full: "", failed: null };
      try {
        await aiChat(
          [
            { role: "system", content: REFINE_SYSTEM_PROMPT },
            { role: "user", content: question },
          ],
          (ev: AiChatEvent) => {
            if (ev.type === "done") state.full = ev.full;
            else if (ev.type === "error") state.failed = ev.message;
          },
        );
      } catch (e) {
        state.failed = aiErrorText(e);
      }
      set({ refining: false });
      if (state.failed) {
        toast.error(t("ai.errorPrefix", { message: state.failed }));
        return;
      }
      const ideas = parsePromptIdeas(state.full).filter((x) => x !== question);
      if (ideas.length === 0) {
        toast.error(t("ai.refineNone"));
        return;
      }
      set({ promptIdeas: ideas });
    },
    clearPromptIdeas: () => set({ promptIdeas: [] }),
  };
});
