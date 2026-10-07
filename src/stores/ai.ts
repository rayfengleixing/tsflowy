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
  /** 撤销某条回复造成的文档改动 */
  undoEdit: (messageId: string) => void;
}

export const useAiStore = create<AiState>()((set, get) => {
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

  /** 组装发给服务端的消息：system + 历史对话（排除空的助手占位） */
  const requestMessages = (assistantId: string): AiChatMessage[] => [
    systemMessage(),
    ...get()
      .messages.filter((m) => m.id !== assistantId && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content })),
  ];

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
      await aiChat(requestMessages(assistantId), (ev: AiChatEvent) => {
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
    }
  };

  return {
    open: false,
    width: loadWidth(),
    messages: [],
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
      await runStream(assistant.id);
    },

    stop: () => {
      aiCancel().catch(() => undefined);
      set({ streaming: false });
    },

    clear: () => set({ messages: [], reasoning: "", error: null }),

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
    },
  };
});
