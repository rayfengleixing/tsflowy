import { create } from "zustand";
import { toast } from "sonner";
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
  docSearchSnippets,
  type AiSessionRow,
  type AiChatEvent,
  type AiChatMessage,
  type AiConfig,
  type AiQuickActionDef,
  type AiUsage,
} from "@/lib/ai";
import { getAiEditor, type AiEditRevert } from "@/lib/ai-editor";
import {
  buildEditSystemPrompt,
  CHAT_ONLY_SYSTEM_PROMPT,
  extractEdit,
  hideEditBlock,
  type AiEditOp,
} from "@/lib/ai-edit";
import { parseMentions } from "@/lib/ai-mention";
import { estimateTokens, tailTokens } from "@/lib/ai-tokens";
import { documentApi } from "@/lib/documents";
import { jsonToMarkdown } from "@/lib/markdown";
import { flattenTree } from "@/lib/tree";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import type { JSONContent } from "@tiptap/core";
import { t, type MessageKey } from "@/lib/i18n";

// AI 助手面板状态：开关/宽度（localStorage 偏好）、消息列表、流式状态、
// 配置缓存与 send / stop / clear / retry / quickAction / undoEdit 动作。

/**
 * 编辑指令的落地状态：
 * pending 待用户确认 / applied 已写入 / rejected 已忽略 /
 * unavailable 没有可编辑文档或事务被结构锁定拦下 / malformed 指令块解析失败
 */
export type AiEditState = "pending" | "applied" | "rejected" | "unavailable" | "malformed";

/** 一条回复附带的文档编辑指令及其落地情况 */
export interface AiEditRecord {
  /** op 为 null 表示指令块解析失败（malformed） */
  op: AiEditOp | null;
  summary: string;
  /** 建议写入的 Markdown 内容 */
  content: string;
  /** 将被替换的原文（插入/追加类为空），用于落地前的 diff 预览 */
  before: string;
  state: AiEditState;
  undone?: boolean;
  /** 撤销句柄（含改前快照），仅当前编辑器实例内有效，不参与持久化 */
  revert?: AiEditRevert;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 本条回复下发的文档编辑指令及其落地结果（用于展示、确认与撤销） */
  edit?: AiEditRecord;
}

/** 快捷动作：前四个基于选中文本，continue 基于整页上下文（不需要选中） */
export type AiQuickAction = "summarize" | "translate" | "rewrite" | "explain" | "continue";

const PANEL_WIDTH_KEY = "tsflowy-ai-panel-width";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const DEFAULT_MAX_CHARS = 8000;

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

/** 归档的历史会话（不含进行中的当前对话） */
export interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: AiMessage[];
  /** 会话发起时所在的页面：历史会话的上下文是那一页，切换页面后不应混淆 */
  pageId?: string | null;
  pageTitle?: string | null;
}

function toSessionRow(s: StoredSession): AiSessionRow {
  return {
    id: s.id,
    title: s.title,
    page_id: s.pageId ?? null,
    page_title: s.pageTitle ?? null,
    updated_at: String(s.updatedAt),
    messages: JSON.stringify(s.messages),
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
  const messages = parsed.map(sanitizeMessage).filter((m): m is AiMessage => m !== null);
  if (messages.length === 0) return null;
  return {
    id: row.id,
    title: row.title,
    updatedAt: Number(row.updated_at) || Date.now(),
    messages,
    pageId: row.page_id,
    pageTitle: row.page_title,
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

/** 恢复时逐条校验消息；edit 指令卡片不恢复（重启后编辑器 undo 栈已空，撤销会错伤无关内容） */
function sanitizeMessage(raw: unknown): AiMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
  return {
    id: typeof m.id === "string" && m.id ? m.id : newId(),
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
  };
}

function restoreSession(raw: unknown): StoredSession | null {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).messages)) return null;
  const rec = raw as Record<string, unknown>;
  const messages = (rec.messages as unknown[])
    .slice(-MAX_SESSION_MESSAGES)
    .map(sanitizeMessage)
    .filter((m): m is AiMessage => m !== null);
  if (messages.length === 0) return null;
  return {
    id: typeof rec.id === "string" && rec.id ? rec.id : newId(),
    title: typeof rec.title === "string" && rec.title ? rec.title : sessionTitle(messages),
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
    messages,
    pageId: typeof rec.pageId === "string" ? rec.pageId : null,
    pageTitle: typeof rec.pageTitle === "string" ? rec.pageTitle : null,
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
  config: AiConfig | null;
  configLoaded: boolean;
  /**
   * 从编辑器（浮动工具栏 / 斜杠菜单）带入的选中内容。
   * 只随下一轮提问生效，发完即清空——作为 system 上下文下发，不占用用户消息正文。
   */
  pendingContext: string | null;
  /** 输入框聚焦请求计数：从编辑器唤起面板时递增，面板据此把光标交给输入框 */
  focusTick: number;

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
  send: (text: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
  retry: () => Promise<void>;
  quickAction: (kind: AiQuickAction) => Promise<void>;
  /** 归档当前对话并开始新会话 */
  newChat: () => void;
  /** 切换到历史会话（当前对话有内容时先归档） */
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** 撤销某条回复造成的文档改动 */
  undoEdit: (messageId: string) => void;
  /** 应用待确认的编辑指令（设置开启「改前确认」后由用户触发） */
  applyPendingEdit: (messageId: string) => void;
  /** 忽略待确认的编辑指令 */
  rejectPendingEdit: (messageId: string) => void;
  /** 切换模型档位（会持久化到配置） */
  switchProfile: (id: string) => Promise<void>;
  /** 执行用户在设置里自定义的快捷指令 */
  runQuickAction: (action: AiQuickActionDef) => Promise<void>;
  /** 从上一条被中断的回答接着往下生成 */
  continueGenerate: () => Promise<void>;
}

export const useAiStore = create<AiState>()((set, get) => {
  const restored = loadSessionsFromStorage();

  /** 当前流式中的助手消息 id：stop() 据此标记「用户主动中止的这一轮」 */
  let streamingAssistantId: string | null = null;
  /** 本轮是否被用户停止：停止后迟到的 done 帧不得再自动落地编辑 */
  let cancelledTurn = false;

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
  }): { sessions: StoredSession[]; archived: StoredSession | null; pruned: string[] } => {
    if (s.messages.length === 0) return { sessions: s.sessions, archived: null, pruned: [] };
    const entry: StoredSession = {
      id: s.activeSessionId,
      title: sessionTitle(s.messages),
      updatedAt: Date.now(),
      messages: s.messages,
      pageId: s.sessionPageId,
      pageTitle: s.sessionPageTitle,
    };
    const list = [entry, ...s.sessions];
    return {
      sessions: list.slice(0, MAX_SESSIONS),
      archived: entry,
      pruned: list.slice(MAX_SESSIONS).map((x) => x.id),
    };
  };

  /** 会话快照落盘（流式增量不触发，只在轮次结束 / 显式操作时调用） */
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
    };
  };

  // 默认落库：localStorage 只有约 5MB 配额，长对话写满后会被迫丢弃历史；落库则没有这个上限。
  // 按条 upsert 而非整表覆盖：单条写失败不至于把其它会话一起清掉。
  const saveSession = (session: StoredSession) => {
    void aiSessionSave(toSessionRow(session)).catch((e: unknown) => {
      logger.warn("ai session save to db failed, fallback to localStorage", e);
      writeLocal(activeSnapshot(), get().sessions);
    });
  };

  const dropSessions = (ids: string[]) => {
    for (const id of ids) {
      void aiSessionDelete(id).catch((e: unknown) => logger.warn("ai session delete failed", e));
    }
  };

  const persistSessions = () => {
    const active = activeSnapshot();
    if (active) saveSession(active);
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
      .messages.filter((m) => m.id !== assistantId && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));
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

  /** 一轮结束：提取编辑指令；默认（confirm_edit 开启）待用户确认后写入，关闭确认时直接落地 */
  const finishAssistant = (assistantId: string, full: string) => {
    const { edit, display, malformed } = extractEdit(full);
    if (!edit) {
      const text = display.trim() || full;
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: text,
                // 指令块有问题：正文已剥掉坏块，这里只留一张提示卡片（没有落地动作，也就没有撤销）
                ...(malformed
                  ? {
                      edit: {
                        op: null,
                        summary: "",
                        content: "",
                        before: "",
                        state: "malformed" as AiEditState,
                      },
                    }
                  : {}),
              }
            : m,
        ),
      }));
      return;
    }
    const bridge = getAiEditor();
    // 没有打开中的文档时无处落地；据实标记，界面会给「未写入」提示
    const record: AiEditRecord = {
      op: edit.op,
      summary: edit.summary,
      content: edit.content,
      // 改前原文：即便直接落地也留一份，之后随时可以「查看改动」
      before: bridge ? bridge.getEditTargetText(edit.op) : "",
      state: "unavailable",
    };
    if (bridge) {
      // 用户按「停止」后迟到的 done 帧不能替用户写文档；与开启确认一样停在待确认
      if (cancelledTurn || get().config?.confirm_edit) {
        // 设置里要求先确认：只给出 diff，等用户点「应用」再写
        record.state = "pending";
      } else {
        const result = bridge.applyEdit(edit.op, edit.content);
        record.state = result.applied ? "applied" : "unavailable";
        record.revert = result.revert;
      }
    }
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              // 正文为空时用 summary 兜底，保证这条消息留在后续对话上下文里
              content: display.trim() || edit.summary,
              edit: record,
            }
          : m,
      ),
    }));
  };

  /** 流式跑一轮：raw 累积模型原始输出，state 里只放「去掉编辑指令块」的展示文本 */
  const runStream = async (assistantId: string) => {
    streamingAssistantId = assistantId;
    cancelledTurn = false;
    let raw = "";
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
    try {
      // @ 引用的文档要先读盘转文本，再随 system 一起下发
      const referenceContext = await buildReferenceContext();
      const outgoing = requestMessages(assistantId, referenceContext);
      // 选中内容只随本轮生效：消息组装完就清掉，下一轮不再重复带
      if (get().pendingContext) set({ pendingContext: null });
      await aiChat(outgoing, (ev: AiChatEvent) => {
        if (ev.type === "chunk") {
          raw += ev.delta;
          pendingDelta += ev.delta;
          flushTimer ??= setTimeout(flush, 60);
        } else if (ev.type === "reasoning") {
          // 推理型模型的思考增量：单独累积，只用于展示，不写进助手消息
          pendingReasoning += ev.delta;
          flushTimer ??= setTimeout(flush, 60);
        } else if (ev.type === "done") {
          // 收尾前先把没来得及提交的增量补上，否则会被 finishAssistant 的结果覆盖
          flushNow();
          finishAssistant(assistantId, ev.full || raw);
          const u = ev.usage;
          if (u) {
            set((s) => ({
              usage: u,
              usageTotal: {
                prompt: s.usageTotal.prompt + (u.prompt_tokens ?? 0),
                completion: s.usageTotal.completion + (u.completion_tokens ?? 0),
                total: s.usageTotal.total + (u.total_tokens ?? 0),
              },
            }));
          }
        } else {
          // 用户主动「停止」时 Rust 会回 cancelled：不算错误，保留已生成的部分内容
          if (ev.message === "cancelled") {
            flushNow();
            return;
          }
          flushNow();
          set({ error: ev.message, errorCode: ev.code ?? null });
          dropEmptyAssistant(assistantId);
        }
      });
    } catch (e) {
      // 起手就失败（未配置 / 命令报错）：没有归类码，界面按通用错误处理
      set({ error: aiErrorText(e), errorCode: null });
      dropEmptyAssistant(assistantId);
    } finally {
      set({ streaming: false });
      streamingAssistantId = null;
      // 一轮结束（含失败/取消）后落盘，流式增量期间不写
      persistSessions();
    }
  };

  return {
    open: false,
    width: loadWidth(),
    messages: restored.active?.messages ?? [],
    sessions: restored.sessions,
    activeSessionId: restored.active?.id ?? restored.activeId,
    reasoning: "",
    streaming: false,
    error: null,
    errorCode: null,
    sessionPageId: null,
    sessionPageTitle: null,
    sessionsLoaded: false,
    usage: null,
    usageTotal: { prompt: 0, completion: 0, total: 0 },
    config: null,
    configLoaded: false,
    pendingContext: null,
    focusTick: 0,

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
      try {
        const rows = await aiSessionList();
        const all = rows
          .slice(0, MAX_SESSIONS + 1)
          .map(fromSessionRow)
          .filter((s): s is StoredSession => s !== null);
        if (all.length > 0) {
          // 库按 updated_at 降序返回，第一条即最近会话
          const active = all[0];
          set({
            messages: active.messages,
            activeSessionId: active.id,
            sessions: all.slice(1),
            sessionPageId: active.pageId ?? null,
            sessionPageTitle: active.pageTitle ?? null,
            sessionsLoaded: true,
          });
          return;
        }
      } catch (e) {
        logger.warn("ai sessions load from db failed, fallback to localStorage", e);
      }
      const local = loadSessionsFromStorage();
      set({
        sessions: local.sessions,
        activeSessionId: local.activeId,
        messages: local.active?.messages ?? [],
        sessionPageId: local.active?.pageId ?? null,
        sessionPageTitle: local.active?.pageTitle ?? null,
        sessionsLoaded: true,
      });
    },
    setConfig: (config) => set({ config, configLoaded: true }),
    setPendingContext: (text) => set({ pendingContext: text }),

    send: async (text) => {
      const content = text.trim();
      if (!content || get().streaming) return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      // 会话首条消息：记下发起时所在的页面，之后历史会话列表能标注它的上下文来源
      const pageRef = get().messages.length === 0 ? currentPageRef() : null;
      set((s) => ({
        open: true,
        error: null,
        errorCode: null,
        reasoning: "",
        streaming: true,
        messages: [...s.messages, { id: newId(), role: "user", content }, assistant],
        ...(pageRef ? { sessionPageId: pageRef.id, sessionPageTitle: pageRef.name } : {}),
      }));
      // 用户消息先落盘，流式中途崩溃也不丢提问
      persistSessions();
      await runStream(assistant.id);
    },

    stop: () => {
      // 标记本轮被用户停止：之后即便 Rust 尾帧（done）晚一步到达，也不会自动落地编辑
      if (streamingAssistantId) cancelledTurn = true;
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
        // 累计用量按会话统计，切过去无从得知历史用量，重置为 0
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      if (archived.archived) saveSession(archived.archived);
      dropSessions(archived.pruned);
    },

    deleteSession: (id) => {
      if (get().streaming) return;
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
      dropSessions([id]);
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
    undoEdit: (messageId) => {
      const bridge = getAiEditor();
      const target = get().messages.find((m) => m.id === messageId);
      if (!bridge || !target?.edit) return;
      if (!bridge.undoAiEdit(target.edit.revert)) {
        toast.error(t("ai.undoFailed"));
        return;
      }
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.edit ? { ...m, edit: { ...m.edit, undone: true } } : m,
        ),
      }));
      persistSessions();
    },

    // 用户在 diff 预览后点「应用」：这才真正写文档
    applyPendingEdit: (messageId) => {
      const bridge = getAiEditor();
      const edit = get().messages.find((m) => m.id === messageId)?.edit;
      if (!edit) return;
      if (edit.state !== "pending" || !edit.op) return;
      if (!bridge) {
        toast.error(t("ai.noEditor"));
        return;
      }
      const result = bridge.applyEdit(edit.op, edit.content);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.edit
            ? {
                ...m,
                edit: {
                  ...m.edit,
                  state: result.applied ? "applied" : "unavailable",
                  revert: result.revert,
                },
              }
            : m,
        ),
      }));
      if (result.applied) toast.success(t("ai.editApplied"));
      persistSessions();
    },

    rejectPendingEdit: (messageId) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.edit?.state === "pending" ? { ...m, edit: { ...m.edit, state: "rejected" } } : m,
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
  };
});
