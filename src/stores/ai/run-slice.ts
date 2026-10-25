import { toast } from "sonner";
import { aiCancel, aiErrorText, type AiChatMessage, type AiToolCallRef } from "@/lib/ai";
import {
  retrievalResultMessage,
  RETRIEVAL_BLOCKED_BY_SCOPE_NOTE,
  type AiWriteCall,
  type RetrievalCall,
} from "@/lib/ai-edit";
import { runRetrievalCall } from "@/lib/ai-tools";
import { getAiEditor } from "@/lib/ai-editor";
import { newId } from "@/lib/db";
import { t } from "@/lib/i18n";
import { flattenTree } from "@/lib/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { collectCalls, isRetrievalCall, isWriteCall } from "./calls";
import type { AiPersistActions } from "./persist";
import { QUICK_PROMPT_KEY } from "./prompts";
import type { AiRequestActions } from "./request-slice";
import type { AiStreamActions } from "./stream-slice";
import type { TurnRegistry } from "./turn-registry";
import type { AiGet, AiMessage, AiSet, AiState } from "./types";

// 一轮问答：界面上的八条动作（send / stop / retry / 两条快捷动作 / 继续生成 / regenerate / resend）
// 与它们共用的 agent 循环（`runStream`，切片私有）。
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

/** 循环要的读数（出请求与流式两片）+ 落盘 + 轮次登记：全部按引用注入，实现文本不改 */
type AiRunDeps = { turn: TurnRegistry } & Pick<
  AiRequestActions,
  "ctxScope" | "agentRounds" | "maxChars" | "requestMessages" | "buildReferenceContext" | "halvedContextBudget"
> &
  Pick<AiStreamActions, "settleIncomplete" | "finalizeAssistant" | "streamRound"> &
  Pick<AiPersistActions, "persistSessions">;

export const createRunSlice = (
  set: AiSet,
  get: AiGet,
  {
    turn,
    ctxScope,
    agentRounds,
    maxChars,
    requestMessages,
    buildReferenceContext,
    halvedContextBudget,
    settleIncomplete,
    finalizeAssistant,
    streamRound,
    persistSessions,
  }: AiRunDeps,
): AiRunActions => {
  /**
   * agent 循环：模型请求 → 若它要求只读检索则本机执行、把结果喂回去再来一轮 →
   * 收敛后统一落地写动作（改文档 / 建页 / 改标题 / 加表行）。
   * 循环放在前端而不是 Rust：页面树、文档、数据库与编辑器的权威状态都在前端。
   */
  const runStream = async (assistantId: string) => {
    turn.assistantId = assistantId;
    const turnId = ++turn.seq;
    /**
     * 本轮是否被用户「停止」：stop() 只标记当前轮号。aiCancel 只能掐断飞行中的请求，
     * 轮次间隙与检索执行阶段没有请求在跑，必须靠循环自己在各边界核对这个标记。
     */
    const cancelledByUser = () => turn.cancelled.has(turnId);
    // usage 是「本轮合计」：先清零，多轮往返才不会被上一轮的用量掺进来
    // retrieving 一并清掉：被停的旧循环可能还挂在检索 await 上，标志是它留下的旧值
    set({ usage: null, retrieving: false });
    // 范围在一轮对话开始时定一次：中途改设置不该让同一轮的前后半段口径不一致
    const scope = ctxScope();
    // 轮次上限也在本轮开始时取一次：中途改设置不该让同一轮的前后半段口径不一致
    const roundLimit = agentRounds();
    // @ 引用的文档要先读盘转文本，再随 system 一起下发；「仅本页」档不带其它文档
    const referenceContext = scope === "page_only" ? "" : await buildReferenceContext();
    let outgoing = requestMessages(assistantId, referenceContext);
    // 选中内容只随本轮生效：消息组装完就清掉，下一轮不再重复带
    if (get().pendingContext) set({ pendingContext: null });
    const writes: AiWriteCall[] = [];
    let lastFull = "";
    let malformed = false;
    let droppedNote = "";
    let cancelled = false;
    let failed: { message: string; code: string | null } | null = null;
    /**
     * 模型窗口比配置的上下文预算小时，服务端直接报超限。这里最多降预算补发两次（每次砍一半），
     * 让用户至少能把这一问问完；一旦检索结果已经拼进 outgoing 就不再重建（重建会丢掉检索内容），
     * 预算低于 500 token 也停手——截到那种长度的对话接不上，不如把报错交给用户。
     */
    let contextShrinks = 0;
    let outgoingGrew = false;
    let shrinkNote = "";
    try {
      for (let round = 0; round < roundLimit; round++) {
        if (cancelledByUser()) {
          cancelled = true;
          break;
        }
        const result = await streamRound(assistantId, outgoing);
        lastFull = result.full;
        cancelled = result.cancelled;
        failed = result.failed;
        if (!cancelled && failed?.code === "context_length" && !outgoingGrew && contextShrinks < 2) {
          const smaller = halvedContextBudget();
          if (smaller !== null) {
            contextShrinks++;
            shrinkNote = t("ai.contextBudgetRetried", { budget: smaller });
            outgoing = requestMessages(assistantId, referenceContext, smaller);
            failed = null;
            lastFull = "";
            // 半截的回答不能和重发后的答案叠在一起，与检索轮一样清空
            set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
            continue;
          }
        }
        if (cancelled || failed) break;
        const { items, malformed: bad } = collectCalls(result.refs, result.full);
        malformed = malformed || bad;
        for (const x of items) if (isWriteCall(x.call)) writes.push(x.call);
        const retrievals = items.filter((x) => isRetrievalCall(x.call));
        if (retrievals.length === 0) break;
        // 「仅本页」档：检索一概不执行。工具没下发，但文本协议块仍可能出现（模型照旧想查），
        // 这里把原因回灌再要一轮答案，否则正文会停在「我先查一下」这种半句话
        if (scope === "page_only") {
          droppedNote = t("ai.searchScopeBlocked");
          outgoing = [
            ...outgoing,
            { role: "assistant", content: result.full },
            { role: "system" as const, content: RETRIEVAL_BLOCKED_BY_SCOPE_NOTE },
          ];
          outgoingGrew = true;
          set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
          continue;
        }
        // 往返已到上限：不再执行检索（结果没机会进答案），只在正文后说明一句
        if (round + 1 >= roundLimit) {
          droppedNote = t("ai.searchRoundLimit", { max: roundLimit });
          break;
        }
        // 此处到 set(retrieving:true) 之间没有 await：停止只可能发生在 await 边界，检查一次即够
        if (cancelledByUser()) {
          cancelled = true;
          break;
        }
        set({ retrieving: true });
        const toolMode = !!get().config?.use_tools;
        const limit = maxChars();
        const toolRefs: AiToolCallRef[] = [];
        const toolMsgs: AiChatMessage[] = [];
        const plain: { tool: string; result: string }[] = [];
        try {
          for (const [i, x] of retrievals.entries()) {
            if (cancelledByUser()) break;
            const call = x.call as RetrievalCall;
            // 函数调用回灌要带原 id；文本协议块没有 id，按序号造一个配套的（assistant 消息里一并声明）
            const id = x.id || `tcall_${round}_${i}`;
            const output = await runRetrievalCall(call.tool, call.args, limit);
            toolRefs.push({
              id,
              type: "function",
              function: { name: call.tool, arguments: JSON.stringify(call.args) },
            });
            if (toolMode) toolMsgs.push({ role: "tool", content: output, tool_call_id: id });
            else plain.push({ tool: call.tool, result: output });
          }
        } finally {
          // 新轮已开始（用户停止后立刻重发）时不再动全局标志，归新轮自己管
          if (turn.seq === turnId) set({ retrieving: false });
        }
        if (cancelledByUser()) {
          cancelled = true;
          break;
        }
        outgoing = [
          ...outgoing,
          { role: "assistant", content: result.full, ...(toolMode ? { tool_calls: toolRefs } : {}) },
          ...(toolMode ? toolMsgs : [{ role: "system" as const, content: retrievalResultMessage(plain) }]),
        ];
        outgoingGrew = true;
        // 下一轮的答案才是给用户看的：本轮文本（多半只是「我先查一下」）清掉，免得两轮内容叠在一起
        set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
      }
      if (failed) {
        set({ error: failed.message, errorCode: failed.code });
        settleIncomplete(assistantId, "error");
      } else if (cancelled) {
        settleIncomplete(assistantId, "stopped");
      } else {
        // 降预算补发成功时也要告诉用户这次是按更小的上下文答的，否则他会以为历史全在
        const note = [droppedNote, shrinkNote].filter(Boolean).join("\n");
        await finalizeAssistant(assistantId, turnId, lastFull, writes, malformed, note);
      }
    } catch (e) {
      // 起手就失败（未配置 / 命令报错）：没有归类码，界面按通用错误处理
      set({ error: aiErrorText(e), errorCode: null });
      settleIncomplete(assistantId, "error");
    } finally {
      turn.cancelled.delete(turnId);
      // 用户停止后又发起了新提问：streaming 状态与在途消息归属新一轮，旧循环不得替它拆掉
      if (turn.seq === turnId) {
        set({ streaming: false, retrieving: false });
        turn.assistantId = null;
      }
      // 一轮结束（含失败/取消）后落盘，流式增量期间不写
      persistSessions();
    }
  };

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
