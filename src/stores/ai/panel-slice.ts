import { aiChat, aiErrorText, type AiChatEvent } from "@/lib/ai";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { MIN_WIDTH, MAX_WIDTH, PANEL_WIDTH_KEY } from "./limits";
import { REFINE_SYSTEM_PROMPT, parsePromptIdeas } from "./prompts";
import type { AiSliceCreator, AiState } from "./types";

// 面板自身那一组动作：开关与宽度、待填上下文、改写提问与输入框状态。
// 与流式轮次无关，也不调其它切片，所以只注入 set / get。
export const createPanelSlice: AiSliceCreator<
  Pick<
    AiState,
    | "toggle"
    | "openPanel"
    | "closePanel"
    | "setWidth"
    | "setPendingContext"
    | "startEdit"
    | "cancelEdit"
    | "refinePrompt"
    | "clearPromptIdeas"
  >
> = (set, get) => {
  return {
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
    setPendingContext: (text) => set({ pendingContext: text }),
    // 改后重发的入口：只标记目标提问，正文由面板填回输入框，用户改完再发送
    startEdit: (messageId) => {
      const s = get();
      if (s.streaming) return;
      const msg = s.messages.find((m) => m.id === messageId);
      if (msg?.role === "user") set({ editingId: messageId, promptIdeas: [] });
    },
    cancelEdit: () => set({ editingId: null }),
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
};
