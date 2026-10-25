import { create } from "zustand";
import { AiState } from "./types";
import { createPersistSlice } from "./persist";
import { createRequestSlice } from "./request-slice";
import { createConfigSlice } from "./config-slice";
import { createPanelSlice } from "./panel-slice";
import { createSessionSlice } from "./session-slice";
import { createMessageSlice } from "./message-slice";
import { createStreamSlice } from "./stream-slice";
import { createRunSlice } from "./run-slice";
import { createTurnRegistry } from "./turn-registry";
import { sessionUsageTotal } from "./ops";
import { MAX_SESSIONS, loadWidth } from "./limits";
import { loadSessionsFromStorage } from "./session-codec";

// AI 助手面板状态：开关/宽度（localStorage 偏好）、消息列表、流式状态、配置缓存——
// 这一层只剩「装配五组切片 + 给出状态初值」，动作的实现都在各自的切片文件里。

export type { AiActionRecord, AiEditState, AiMessage, AiQuickAction, SessionUsage, StoredSession } from "./types";
export {
  AI_WIDTH_LIMITS,
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TOKEN_BUDGET,
} from "./limits";
export { visibleSessionWindow } from "./session-codec";

export const useAiStore = create<AiState>()((set, get) => {
  const restored = loadSessionsFromStorage();

  /**
   * 轮次登记：在流的助手 id、轮号、被用户停过的轮号集合。
   * 原来是 `create` 闭包里的两个 `let` 标量加一个 Set，收进对象以后按引用注入 run / 流式切片，
   * 两边读写的是同一份（见 turn-registry.ts 头部）。
   */
  const turn = createTurnRegistry();

  /** 会话落盘切片：实现逐字搬进 persist.ts，set / get 由这里注入 */
  const { fetchUsage, saveSession, dropSessions, persistSessions, applyLocal } = createPersistSlice(set, get);

  /** 出请求切片：派生与组装逐字搬进 request-slice.ts，get 由这里注入 */
  const { maxChars, agentRounds, halvedContextBudget, ctxScope, requestMessages, buildReferenceContext } =
    createRequestSlice(get);

  /** 流式切片：一轮请求与收尾四个助手逐字搬进 stream-slice.ts，set / get 由这里注入，
   * 被停止的轮次集合与上下文范围按引用传进去（这两个都不是重新赋值，注入不改实现文本） */
  const { settleIncomplete, finalizeAssistant, streamRound } = createStreamSlice(set, get, {
    cancelledTurns: turn.cancelled,
    ctxScope,
  });

  /** 一轮问答的编排：agent 循环（runStream）与界面上的七条动作逐字搬进 run-slice.ts */
  return {
    // 配置/档位与面板自身这两组动作只读写 config、宽度等自己的状态，切进各自的切片文件
    ...createConfigSlice(set, get),
    ...createPanelSlice(set, get),
    ...createSessionSlice(set, get, { saveSession, dropSessions, applyLocal, fetchUsage }),
    // 单条消息上的动作（评分 / 撤销 / 确认落地 / 另存 / 导出）切进 message-slice.ts
    ...createMessageSlice(set, get, { persistSessions }),
    // 一轮问答那组动作：轮次登记（同一个 Set 与两个字段）与出请求、流式两片的读数按引用注入，实现文本不改
    ...createRunSlice(set, get, {
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
    }),
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
    sessionsShown: MAX_SESSIONS,
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
  };
});
