import { aiSessionList, type AiSessionRow } from "@/lib/ai";
import { newId } from "@/lib/db";
import { logger } from "@/lib/logger";
import { MAX_SESSIONS } from "./limits";
import type { AiPersistActions } from "./persist";
import { archiveCurrent, importLocalSessions, sessionUsageTotal } from "./ops";
import { fromSessionRow, loadSessionsFromStorage, sessionTitle } from "./session-codec";
import type { AiGet, AiSet, AiState, StoredSession } from "./types";

// 会话历史这一组动作：列表、归档、切换、改名、分支与显示窗口。
// 它们要写库（`ai_session_save` / 删除）所以依赖落盘切片的四个动作，那四个不在 `AiState` 上、
// 只在 `createPersistSlice` 的返回值里，因此由 index 把解构结果按同名参数注入进来——
// 这样下面九个动作的实现文本一字都不用改。
type AiPersistDeps = Pick<AiPersistActions, "saveSession" | "dropSessions" | "applyLocal" | "fetchUsage">;

export const createSessionSlice = (
  set: AiSet,
  get: AiGet,
  { saveSession, dropSessions, applyLocal, fetchUsage }: AiPersistDeps,
): Pick<
  AiState,
  | "loadSessions"
  | "loadMoreSessions"
  | "clear"
  | "newChat"
  | "switchSession"
  | "deleteSession"
  | "renameSession"
  | "setSessionArchived"
  | "branchFrom"
> => {
  return {
    // 历史会话优先从库里读（localStorage 只有约 5MB 配额）；库为空或不可用时再用本地老数据
    loadSessions: async () => {
      if (get().sessionsLoaded) return;
      const local = loadSessionsFromStorage();
      let rows: AiSessionRow[];
      try {
        rows = await aiSessionList();
      } catch (e) {
        logger.warn("ai sessions load from db failed, fallback to localStorage", e);
        applyLocal(local);
        return;
      }
      // 库按 updated_at 降序返回。全部保留：历史上超出的会话曾因不可见又被静默删除，
      // 现在改由面板显示窗口（sessionsShown）控制，数据一条不丢。
      const all: StoredSession[] = [];
      for (const r of rows) {
        const s = fromSessionRow(r);
        if (s) all.push(s);
      }
      if (all.length === 0) {
        const pending = [local.active, ...local.sessions].filter((s): s is StoredSession => s !== null);
        // 导入失败（或本地本来就没会话）就沿用本地那份，下次启动还会重试
        if (pending.length === 0 || !(await importLocalSessions(pending))) {
          applyLocal(local);
          return;
        }
        // 保持本地那份的当前会话在第一位，切过来还是用户正在看的那段对话
        all.push(...pending);
      }
      // 当前对话取最近一条未归档的；全被归档了就退回最近那条
      const fresh = all.findIndex((x) => !x.archived);
      const active = all[fresh < 0 ? 0 : fresh];
      set({
        messages: active.messages,
        activeSessionId: active.id,
        sessions: all.filter((x) => x.id !== active.id),
        sessionPageId: active.pageId ?? null,
        sessionPageTitle: active.pageTitle ?? null,
        usageTotal: sessionUsageTotal(active.usage),
        sessionsLoaded: true,
      });
      fetchUsage();
    },
    loadMoreSessions: () => set((s) => ({ sessionsShown: s.sessionsShown + MAX_SESSIONS })),
    clear: () => {
      const hadContent = get().messages.length > 0;
      const oldId = get().activeSessionId;
      set({
        messages: [],
        reasoning: "",
        error: null,
        errorCode: null,
        editingId: null,
        promptIdeas: [],
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      // 清空即销毁这一会话：按 id 删除它的库行，而不是留下空壳
      if (hadContent) dropSessions([oldId]);
    },
    /** 归档当前对话并开始新会话 */
    newChat: () => {
      const { sessions, archived } = archiveCurrent(get());
      set({
        sessions,
        messages: [],
        reasoning: "",
        error: null,
        errorCode: null,
        editingId: null,
        promptIdeas: [],
        // 新会话的关联页面等第一条消息时再定
        sessionPageId: null,
        sessionPageTitle: null,
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
        activeSessionId: newId(),
      });
      if (archived) saveSession(archived);
    },
    /** 切换到历史会话（当前对话有内容时先归档；流式进行中不允许切） */
    switchSession: (id) => {
      const s = get();
      if (s.streaming) return;
      const target = s.sessions.find((x) => x.id === id);
      if (!target) return;
      const rest = s.sessions.filter((x) => x.id !== id);
      const archived = archiveCurrent({ ...s, sessions: rest });
      set({
        sessions: archived.sessions,
        messages: target.messages,
        activeSessionId: target.id,
        sessionPageId: target.pageId ?? null,
        sessionPageTitle: target.pageTitle ?? null,
        reasoning: "",
        error: null,
        errorCode: null,
        // 换会话后消息列表整个换掉，待修改的提问 id 不再指向任何消息
        editingId: null,
        promptIdeas: [],
        // 累计用量按会话统计：切过去先接上它自己那份历史用量，本轮再往上累加
        usage: null,
        usageTotal: sessionUsageTotal(target.usage),
      });
      if (archived.archived) saveSession(archived.archived);
    },
    deleteSession: (id) => {
      if (get().streaming) return;
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
      dropSessions([id]);
    },
    // 改名与归档都只动历史列表里的那一行：整行 upsert，不需要额外的命令
    renameSession: (id, rawTitle) => {
      const title = rawTitle.trim().slice(0, 60);
      const target = get().sessions.find((x) => x.id === id);
      if (!title || !target || target.title === title) return;
      const next = { ...target, title };
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? next : x)) }));
      saveSession(next);
    },
    setSessionArchived: (id, archived) => {
      const target = get().sessions.find((x) => x.id === id);
      if (!target || target.archived === archived) return;
      const next = { ...target, archived };
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? next : x)) }));
      saveSession(next);
    },
    branchFrom: (messageId) => {
      const s = get();
      if (s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      if (i < 0) return;
      const prefix = s.messages.slice(0, i + 1);
      // 原对话整段归档保留，分支是一个新会话，两条线互不影响
      const { sessions, archived } = archiveCurrent(s);
      const branch: StoredSession = {
        id: newId(),
        title: sessionTitle(prefix),
        updatedAt: Date.now(),
        messages: prefix,
        pageId: s.sessionPageId,
        pageTitle: s.sessionPageTitle,
      };
      set({
        sessions,
        messages: prefix,
        activeSessionId: branch.id,
        editingId: null,
        promptIdeas: [],
        reasoning: "",
        error: null,
        errorCode: null,
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      if (archived) saveSession(archived);
      saveSession(branch);
    },
  };
};
