// agent 循环：一轮问答里真正跟模型打交道的那段——发请求、本机执行模型要的只读检索、把结果喂回下一轮、
// 收敛后把写动作交给流式切片的收尾。从 run-slice.ts 原样搬出，循环本体逐行零改动。
//
// 单独成文件的理由：循环要的读数正好就是原来那份注入清单（下面 `AiRunDeps` 的 11 项，名字与顺序都没动），
// 而界面上的八条动作只用得到其中三项（maxChars / persistSessions / turn）——注入面按真实需求分开了。
// 循环仍是切片私有的：装配方（stores/ai/index.ts）只认 createRunSlice，这里多出来的导出是一个工厂和两个类型。
import { aiErrorText, type AiChatMessage, type AiToolCallRef } from "@/lib/ai";
import {
  retrievalResultMessage,
  RETRIEVAL_BLOCKED_BY_SCOPE_NOTE,
  type AiWriteCall,
  type RetrievalCall,
} from "@/lib/ai-edit";
import { runRetrievalCall } from "@/lib/ai-tools";
import { t } from "@/lib/i18n";
import { collectCalls, isRetrievalCall, isWriteCall } from "./calls";
import type { AiPersistActions } from "./persist";
import type { AiRequestActions } from "./request-slice";
import type { AiStreamActions } from "./stream-slice";
import type { TurnRegistry } from "./turn-registry";
import type { AiGet, AiSet } from "./types";

/** 循环要的读数（出请求与流式两片）+ 落盘 + 轮次登记：全部按引用注入，实现文本不改 */
export type AiRunDeps = { turn: TurnRegistry } & Pick<
  AiRequestActions,
  "ctxScope" | "agentRounds" | "maxChars" | "requestMessages" | "buildReferenceContext" | "halvedContextBudget"
> &
  Pick<AiStreamActions, "settleIncomplete" | "finalizeAssistant" | "streamRound"> &
  Pick<AiPersistActions, "persistSessions">;

/** 循环的形状：给在流消息的 id，跑完整一轮并自行收尾（落盘、拆 streaming 都在这里） */
export type RunStream = (assistantId: string) => Promise<void>;

export const createRunStream = (
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
): RunStream => {
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
  return runStream;
};
