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
import { t, type MessageKey } from "@/lib/i18n";

// AI 助手面板状态：开关/宽度（localStorage 偏好）、消息列表、流式状态、
// 配置缓存与 send / stop / clear / retry / quickAction 动作。

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
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
}

export const useAiStore = create<AiState>()((set, get) => {
  /** 组装发给服务端的消息：排除空的助手占位与空内容 */
  const requestMessages = (assistantId: string): AiChatMessage[] =>
    get()
      .messages.filter((m) => m.id !== assistantId && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

  /** 失败时丢弃空的助手占位（保留有内容的半截回答），错误单独存供重试 */
  const dropEmptyAssistant = (assistantId: string) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== assistantId || m.content.trim().length > 0) }));

  /** 流式跑一轮：把助手消息 id 作为写入目标 */
  const runStream = async (assistantId: string) => {
    try {
      await aiChat(requestMessages(assistantId), (ev: AiChatEvent) => {
        if (ev.type === "chunk") {
          set((s) => ({
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + ev.delta } : m)),
          }));
        } else if (ev.type === "reasoning") {
          // 推理型模型的思考增量：单独累积，只用于展示，不写进助手消息
          set((s) => ({ reasoning: s.reasoning + ev.delta }));
        } else if (ev.type === "done") {
          set((s) => ({
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: ev.full || m.content } : m)),
          }));
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
      const configuredMax = get().config?.max_chars;
      const maxChars = configuredMax && configuredMax > 0 ? configuredMax : DEFAULT_MAX_CHARS;
      let content: string;
      if (kind === "summarize") {
        const page = bridge?.getPageText().trim() ?? "";
        if (!page) {
          toast.error(t("ai.noPage"));
          return;
        }
        content = page.slice(0, maxChars);
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
  };
});
