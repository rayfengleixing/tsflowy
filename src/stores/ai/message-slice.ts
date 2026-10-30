import { aiErrorText } from "@/lib/ai";
import { getAiEditor } from "@/lib/ai/ai-editor";
import { runUndoPlan, runWriteAction } from "@/lib/ai-tools";
import { invoke } from "@/lib/invoke";
import { save } from "@/lib/ipc/ipc-dialog";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { landAction } from "./edit-ops";
import type { AiPersistActions } from "./persist";
import { pageTitleFrom } from "./prompts";
import type { AiGet, AiSet, AiState } from "./types";

// 单条消息上的动作：评分、撤销、确认落地/驳回、另存为页面、导出。
// 其中四处要随会话落盘，`persistSessions` 不在 `AiState` 上、只在 `createPersistSlice` 的返回值里，
// 因此由 index 把解构结果按同名参数注入——下面六个动作的实现文本一字都不用改。

export const createMessageSlice = (
  set: AiSet,
  get: AiGet,
  { persistSessions }: Pick<AiPersistActions, "persistSessions">,
): Pick<
  AiState,
  "rateMessage" | "undoAction" | "applyAction" | "rejectAction" | "saveMessageAsPage" | "exportMessage"
> => {
  return {
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

    // 撤销一个已落地的动作：页面/表数据按落库时留下的逆操作计划回滚（重启后仍撤得动），
    // 文档编辑按当前编辑器 undo 栈里的改前快照回滚，撤不动时明确告知而不是静默撤掉用户的编辑
    undoAction: async (messageId, index) => {
      const rec = get().messages.find((m) => m.id === messageId)?.actions?.[index];
      if (!rec) return;
      const markUndone = () => {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === messageId && m.actions
              ? { ...m, actions: m.actions.map((a, i) => (i === index ? { ...a, undone: true } : a)) }
              : m,
          ),
        }));
        persistSessions();
      };
      if (rec.undo) {
        const done = await runUndoPlan(rec.undo);
        if (!done.ok) {
          toast.error(done.detail);
          return;
        }
        toast.success(done.detail);
        markUndone();
        return;
      }
      const bridge = getAiEditor();
      if (!bridge || !rec.revert) return;
      if (!bridge.undoAiEdit(rec.revert)) {
        toast.error(t("ai.undoFailed"));
        return;
      }
      markUndone();
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
  };
};
