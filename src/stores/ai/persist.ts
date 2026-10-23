import { aiSessionSave, aiSessionDelete, aiUsageSummary } from "@/lib/ai";
import { logger } from "@/lib/logger";
import { MAX_SESSIONS, SESSIONS_KEY } from "./limits";
import { sessionUsageTotal } from "./ops";
import { LocalSessions, sessionTitle, toSessionRow } from "./session-codec";
import { type AiSliceCreator, StoredSession } from "./types";

// 会话落盘切片：写库为主、localStorage 只作兜底。set / get 由 store 工厂注入，切片内部互相调用保持原样。
export interface AiPersistActions {
  fetchUsage: () => void;
  saveSession: (session: StoredSession) => void;
  dropSessions: (ids: string[]) => void;
  persistSessions: () => void;
  applyLocal: (local: LocalSessions) => void;
}

export const createPersistSlice: AiSliceCreator<AiPersistActions> = (set, get) => {
  /** 会话快照落盘（流式增量不触发，只在轮次结束 / 显式操作时调用） */
  /** 跨会话 token 累计：库不可用时清掉即可，用量条是锦上添花，不该弹错打扰 */
  const fetchUsage = () => {
    void aiUsageSummary()
      .then((v) => set({ usageSummary: v }))
      .catch(() => set({ usageSummary: null }));
  };

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
      usage: { prompt: s.usageTotal.prompt, completion: s.usageTotal.completion },
    };
  };

  // 默认落库：localStorage 只有约 5MB 配额，长对话写满后会被迫丢弃历史；落库则没有这个上限。
  // 按条 upsert 而非整表覆盖：单条写失败不至于把其它会话一起清掉。
  const saveSession = (session: StoredSession) => {
    void aiSessionSave(toSessionRow(session))
      .then(fetchUsage)
      .catch((e: unknown) => {
        logger.warn("ai session save to db failed, fallback to localStorage", e);
        writeLocal(activeSnapshot(), get().sessions);
      });
  };

  const dropSessions = (ids: string[]) => {
    if (ids.length === 0) return;
    const ops = ids.map((id) => aiSessionDelete(id).catch((e: unknown) => logger.warn("ai session delete failed", e)));
    // 删除影响累计用量：等写请求落地再重取，否则拿到的还是删之前的数
    void Promise.allSettled(ops).then(fetchUsage);
  };

  const persistSessions = () => {
    const active = activeSnapshot();
    if (active) saveSession(active);
  };

  /** 本地（localStorage）那份老数据直接充当当前状态：库不可用、或库与本地都空时走这里 */
  const applyLocal = (local: LocalSessions) =>
    set({
      sessions: local.sessions,
      activeSessionId: local.activeId,
      messages: local.active?.messages ?? [],
      sessionPageId: local.active?.pageId ?? null,
      sessionPageTitle: local.active?.pageTitle ?? null,
      usageTotal: sessionUsageTotal(local.active?.usage),
      sessionsLoaded: true,
    });
  // writeLocal / activeSnapshot 只被本切片内部调用，不放进对外动作面
  return { fetchUsage, saveSession, dropSessions, persistSessions, applyLocal };
};
