import { create } from "zustand";
import { toast } from "sonner";
import { newId } from "@/lib/db";
import {
  aiCancel,
  aiChat,
  aiErrorText,
  aiGetConfig,
  type AiChatEvent,
  type AiChatMessage,
  type AiConfig,
} from "@/lib/ai";
import { getAiEditor } from "@/lib/ai-editor";
import {
  buildEditSystemPrompt,
  CHAT_ONLY_SYSTEM_PROMPT,
  extractEdit,
  hideEditBlock,
  type AiEditOp,
} from "@/lib/ai-edit";
import { parseMentions } from "@/lib/ai-mention";
import { documentApi } from "@/lib/documents";
import { jsonToMarkdown } from "@/lib/markdown";
import { flattenTree } from "@/lib/tree";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import type { JSONContent } from "@tiptap/core";
import { t, type MessageKey } from "@/lib/i18n";

// AI 助手面板状态：开关/宽度（localStorage 偏好）、消息列表、流式状态、
// 配置缓存与 send / stop / clear / retry / quickAction / undoEdit 动作。

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 本条回复下发的文档编辑指令及其落地结果（用于展示与撤销） */
  edit?: { op: AiEditOp; summary: string; applied: boolean; undone?: boolean };
}

export type AiQuickAction = "summarize" | "translate" | "rewrite" | "explain";

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
// 长对话防超限：历史消息从最新往前收进字符预算，放不下的早期轮次直接丢弃
// （system prompt 与 @ 引用上下文不占预算，不受影响）
const HISTORY_CHAR_BUDGET = 8000;
const HISTORY_MAX_MESSAGES = 40;

/** 归档的历史会话（不含进行中的当前对话） */
export interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: AiMessage[];
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
  };
}

/** 从 localStorage 恢复会话（损坏/缺失时返回空态） */
function loadSessions(): { activeId: string; sessions: StoredSession[]; active: StoredSession | null } {
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
  config: AiConfig | null;
  configLoaded: boolean;

  toggle: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setWidth: (w: number) => void;
  loadConfig: () => Promise<void>;
  setConfig: (c: AiConfig) => void;
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
}

export const useAiStore = create<AiState>()((set, get) => {
  const restored = loadSessions();

  /** 当前对话有内容时归档进 sessions（超出上限丢最老），供 newChat / 切换会话复用 */
  const archiveCurrent = (s: {
    messages: AiMessage[];
    sessions: StoredSession[];
    activeSessionId: string;
  }): StoredSession[] => {
    if (s.messages.length === 0) return s.sessions;
    const entry: StoredSession = {
      id: s.activeSessionId,
      title: sessionTitle(s.messages),
      updatedAt: Date.now(),
      messages: s.messages,
    };
    return [entry, ...s.sessions].slice(0, MAX_SESSIONS);
  };

  /** 会话快照落盘（流式增量不触发，只在轮次结束 / 显式操作时调用） */
  const persistSessions = () => {
    const s = get();
    const active: StoredSession | null =
      s.messages.length > 0
        ? { id: s.activeSessionId, title: sessionTitle(s.messages), updatedAt: Date.now(), messages: s.messages }
        : null;
    const write = (sessions: StoredSession[]) =>
      localStorage.setItem(SESSIONS_KEY, JSON.stringify({ activeId: s.activeSessionId, sessions, active }));
    try {
      write(s.sessions);
    } catch {
      // 配额溢出：丢一半最老的归档重试一次，仍失败则放弃（不影响使用）
      try {
        write(s.sessions.slice(0, Math.floor(MAX_SESSIONS / 2)));
      } catch (e) {
        logger.warn("ai sessions persist failed", e);
      }
    }
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
    // 长对话防超限：从最新往前收进字符预算，放不下的早期轮次丢弃
    const kept: AiChatMessage[] = [];
    let budget = HISTORY_CHAR_BUDGET;
    for (let i = history.length - 1; i >= 0 && kept.length < HISTORY_MAX_MESSAGES; i--) {
      const m = history[i];
      if (m.content.length > budget) {
        // 一条都放不下（如首轮就粘贴长文）：保最新一条的尾部
        if (kept.length === 0) kept.push({ role: m.role, content: m.content.slice(-HISTORY_CHAR_BUDGET) });
        break;
      }
      budget -= m.content.length;
      kept.unshift(m);
    }
    return [
      systemMessage(),
      ...(referenceContext ? [{ role: "system" as const, content: referenceContext }] : []),
      ...kept,
    ];
  };

  /**
   * 用户消息里 `@文件名` 引用的文档 → 参考上下文：读磁盘快照、转 Markdown、按 max_chars 截断。
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
    const parts: string[] = [];
    for (const ref of refs) {
      try {
        const raw = await documentApi.get(ref.id);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as JSONContent | JSONContent[];
        const doc: JSONContent = Array.isArray(parsed) ? { type: "doc", content: parsed } : parsed;
        const md = jsonToMarkdown(doc).trim();
        if (!md) continue;
        parts.push(`### ${ref.name}\n${md.slice(0, limit)}`);
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

  /** 一轮结束：提取编辑指令并直接应用到文档（AI 自主修改），同时留下结果卡片供撤销 */
  const finishAssistant = (assistantId: string, full: string) => {
    const { edit, display } = extractEdit(full);
    if (!edit) {
      const text = display.trim() || full;
      set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: text } : m)) }));
      return;
    }
    const bridge = getAiEditor();
    // 没有打开中的文档时无法落地；据实标记，界面会给「未应用」提示
    const applied = bridge ? bridge.applyEdit(edit.op, edit.content) : false;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              // 正文为空时用 summary 兜底，保证这条消息留在后续对话上下文里
              content: display.trim() || edit.summary,
              edit: { op: edit.op, summary: edit.summary, applied },
            }
          : m,
      ),
    }));
  };

  /** 流式跑一轮：raw 累积模型原始输出，state 里只放「去掉编辑指令块」的展示文本 */
  const runStream = async (assistantId: string) => {
    let raw = "";
    try {
      // @ 引用的文档要先读盘转文本，再随 system 一起下发
      const referenceContext = await buildReferenceContext();
      await aiChat(requestMessages(assistantId, referenceContext), (ev: AiChatEvent) => {
        if (ev.type === "chunk") {
          raw += ev.delta;
          const display = hideEditBlock(raw);
          set((s) => ({
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: display } : m)),
          }));
        } else if (ev.type === "reasoning") {
          // 推理型模型的思考增量：单独累积，只用于展示，不写进助手消息
          set((s) => ({ reasoning: s.reasoning + ev.delta }));
        } else if (ev.type === "done") {
          finishAssistant(assistantId, ev.full || raw);
        } else {
          // 用户主动「停止」时 Rust 会回 cancelled：不算错误，保留已生成的部分内容
          if (ev.message === "cancelled") return;
          set({ error: ev.message });
          dropEmptyAssistant(assistantId);
        }
      });
    } catch (e) {
      set({ error: aiErrorText(e) });
      dropEmptyAssistant(assistantId);
    } finally {
      set({ streaming: false });
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
    config: null,
    configLoaded: false,

    toggle: () => set((s) => ({ open: !s.open })),
    openPanel: () => set({ open: true }),
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
    setConfig: (config) => set({ config, configLoaded: true }),

    send: async (text) => {
      const content = text.trim();
      if (!content || get().streaming) return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set((s) => ({
        open: true,
        error: null,
        reasoning: "",
        streaming: true,
        messages: [...s.messages, { id: newId(), role: "user", content }, assistant],
      }));
      // 用户消息先落盘，流式中途崩溃也不丢提问
      persistSessions();
      await runStream(assistant.id);
    },

    stop: () => {
      aiCancel().catch(() => undefined);
      set({ streaming: false });
    },

    clear: () => {
      set({ messages: [], reasoning: "", error: null });
      persistSessions();
    },

    /** 归档当前对话并开始新会话 */
    newChat: () => {
      set((s) => ({
        sessions: archiveCurrent(s),
        messages: [],
        reasoning: "",
        error: null,
        activeSessionId: newId(),
      }));
      persistSessions();
    },

    /** 切换到历史会话（当前对话有内容时先归档；流式进行中不允许切） */
    switchSession: (id) => {
      const s = get();
      if (s.streaming) return;
      const target = s.sessions.find((x) => x.id === id);
      if (!target) return;
      const rest = s.sessions.filter((x) => x.id !== id);
      set({
        sessions: archiveCurrent({ ...s, sessions: rest }),
        messages: target.messages,
        activeSessionId: target.id,
        reasoning: "",
        error: null,
      });
      persistSessions();
    },

    deleteSession: (id) => {
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
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
      set({ messages: [...msgs, assistant], reasoning: "", streaming: true, error: null });
      await runStream(assistant.id);
    },

    // 快捷动作：总结当前页取整页纯文本（按 max_chars 截断）；其余三个用选中文本
    quickAction: async (kind) => {
      const bridge = getAiEditor();
      const limit = maxChars();
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

    // 撤销 AI 的自动改写：走编辑器自身的 undo 栈（与 Ctrl+Z 同一条链路）
    undoEdit: (messageId) => {
      const bridge = getAiEditor();
      if (!bridge) return;
      bridge.undo();
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.edit ? { ...m, edit: { ...m.edit, undone: true } } : m,
        ),
      }));
      persistSessions();
    },
  };
});
