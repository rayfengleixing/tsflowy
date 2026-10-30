import { toast } from "sonner";
import { aiCancel } from "@/lib/ai";
import { getAiEditor } from "@/lib/ai/ai-editor";
import { newId } from "@/lib/backend/db";
import { t } from "@/lib/i18n";
import { flattenTree } from "@/lib/doc/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { QUICK_PROMPT_KEY } from "./prompts";
import { createRunStream, type AiRunDeps } from "./run-stream";
import type { AiGet, AiMessage, AiSet, AiState } from "./types";

// 一轮问答：界面上的八条动作（send / stop / retry / 两条快捷动作 / 继续生成 / regenerate / resend）
// 与它们共用的 agent 循环在 run-stream.ts（本批切出）：这里只留动作本身，和八条动作真用到的那三项读数。
// 这一簇是最后离开 `create` 闭包的：循环要读写轮次那三个值（在流的助手 id、轮号、被停的轮号集合），
// 而闭包里的 `let` 标量一旦被别的模块接走，写的和读的就不是同一份。值收进 `TurnRegistry` 之后，
// 切片拿到的是引用，实现文本除把 `streamingAssistantId` / `turnSeq` / `cancelledTurns` 换成
// `turn.assistantId` / `turn.seq` / `turn.cancelled` 之外一字未动。
// `cancelledTurns` 那个 `Set` 与 `ctxScope` 那类派生读数按同名注入，理由同 stream-slice / session-slice。

/** 当前打开的页面（用于给会话标注上下文来源） */
function currentPageRef(): { id: string; name: string } | null {
  const s = useWorkspaceStore.getState();
  if (!s.currentViewId) return null;
  const node = flattenTree(s.tree).find((v) => v.id === s.currentViewId);
  return { id: s.currentViewId, name: node?.name ?? "" };
}

/** 状态面上的这八条都在 `AiState` 里有声明；`runStream` 只在切片内部被 send / retry 那几条调用 */
export type AiRunActions = Pick<
  AiState,
  "send" | "stop" | "retry" | "quickAction" | "runQuickAction" | "continueGenerate" | "regenerate" | "resend"
>;

export const createRunSlice = (set: AiSet, get: AiGet, deps: AiRunDeps): AiRunActions => {
  /** 循环本体逐字在 run-stream.ts；11 项读数原样转过去，循环文本不改 */
  const runStream = createRunStream(set, get, deps);
  const { maxChars, persistSessions, turn } = deps;

  return {
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
      // 只标记「当时正在流的那一轮」，不影响用户随后立刻发起的新轮。
      // agent 循环在每轮开始与每个检索步骤前核对这个标记：aiCancel 只掐得断飞行中的请求，
      // 检索/工具执行阶段没有请求在跑，靠循环自己在边界退出。
      if (turn.assistantId) turn.cancelled.add(turn.seq);
      aiCancel().catch(() => undefined);
      set({ streaming: false });
    },

    retry: async () => {
      if (get().streaming) return;
      const msgs = [...get().messages];
      // 失败/停止留下的半截回答：整条丢弃后重发这一问（想接着半截往下写走「继续生成」）
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant" && msgs[msgs.length - 1].incomplete) msgs.pop();
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
  };
};
