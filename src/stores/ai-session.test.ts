// AI store 单测（按主题拆自 `ai.test.ts`）：会话生命周期与消息动作：归档/切换/删除、动作卡片随会话恢复、编辑重发、显示窗口加载。
// 桩包必须每个测试文件各造一份：`vi.mock` 与 `vi.hoisted` 由 vitest 提到本文件的 import 之前，跨文件复用会踩空，
// 所以只有 mock 表各留一份，其余骨架（helper、根级 beforeEach、localStorage 替身）共用 `test/ai-store-harness.ts`。
import { describe, expect, it, vi } from "vitest";
import type { AiChatMessage } from "@/lib/ai";
import {
  bindAiMocks,
  completeTurn,
  loadConfiguredStore,
  loadStore,
  pump,
  session,
  startTurn,
  storage,
  streamHandlers,
} from "@/test/ai-store-harness";

// AI store 单测：IPC / 编辑器桥 / 工具执行层 / 工作区全部打桩，只验证 store 自身的编排逻辑
// （落库时机、token 预算截断、停止后动作竞态、agent 多步循环、会话归档/显示窗口）。

const M = vi.hoisted(() => ({
  aiChat: vi.fn((_msgs: unknown, _onEvent: unknown, _tools?: unknown) => Promise.resolve()),
  aiCancel: vi.fn(() => Promise.resolve()),
  aiGetConfig: vi.fn((): Promise<unknown> => Promise.resolve({})),
  aiSaveConfig: vi.fn((_input: Record<string, unknown>) => Promise.resolve()),
  aiSessionList: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  aiSessionSave: vi.fn((_row: unknown) => Promise.resolve()),
  aiSessionDelete: vi.fn((_id: string) => Promise.resolve()),
  aiUsageSummary: vi.fn((): Promise<unknown> =>
    Promise.resolve({ sessions: 0, prompt_tokens: 0, completion_tokens: 0 }),
  ),
  docSearchSnippets: vi.fn(() => Promise.resolve([] as string[])),
  getAiEditor: vi.fn((): unknown => null),
  getAiEditorForView: vi.fn((): unknown => null),
  applyEdit: vi.fn((_op: string, _content: string, _anchor?: unknown) => ({ applied: true, revert: {} })),
  undoAiEdit: vi.fn((_revert: unknown) => true),
  documentGet: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  documentSave: vi.fn(() => Promise.resolve()),
  runRetrievalCall: vi.fn(() => Promise.resolve("检索桩结果")),
  runWriteAction: vi.fn((): Promise<unknown> => Promise.resolve({ ok: true, detail: "已执行" })),
  runUndoPlan: vi.fn((): Promise<unknown> => Promise.resolve({ ok: true, detail: "已撤销" })),
  resolvePage: vi.fn((): unknown => null),
  applyEditToDocJson: vi.fn((): unknown => ({ ok: false, reason: "bad_structure" })),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  newId: vi.fn(() => "id-1"),
  workspaceState: { currentViewId: null as string | null, tree: [] as unknown[] },
  bridge: {
    getPageTitle: () => "标题",
    getSelectionText: () => "选中",
    getPageText: () => "整页文本",
    getEditTargetText: (_op: string) => "原文",
    applyEdit: (op: string, content: string, anchor?: unknown) => M.applyEdit(op, content, anchor),
    undoAiEdit: (revert: unknown) => M.undoAiEdit(revert),
  },
}));

vi.mock("@/lib/ai", () => ({
  aiChat: M.aiChat,
  aiCancel: M.aiCancel,
  aiGetConfig: M.aiGetConfig,
  aiSaveConfig: M.aiSaveConfig,
  aiSessionList: M.aiSessionList,
  aiSessionSave: M.aiSessionSave,
  aiSessionDelete: M.aiSessionDelete,
  aiUsageSummary: M.aiUsageSummary,
  docSearchSnippets: M.docSearchSnippets,
  aiErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/ai-editor", () => ({ getAiEditor: M.getAiEditor, getAiEditorForView: M.getAiEditorForView }));
vi.mock("@/lib/db", () => ({ newId: M.newId }));
vi.mock("@/lib/documents", () => ({ documentApi: { get: M.documentGet, save: M.documentSave } }));
// 工具执行层自带一堆库访问依赖，单测里只关心 store 怎么调度它
vi.mock("@/lib/ai-tools", () => ({
  aiToolSpecs: () => [],
  runRetrievalCall: M.runRetrievalCall,
  runWriteAction: M.runWriteAction,
  runUndoPlan: M.runUndoPlan,
  resolvePage: M.resolvePage,
  // 逆操作计划是纯数据，形状校验由 ai-tools 自己的单测覆盖；这里原样放行
  sanitizeUndoPlan: (v: unknown) => v,
}));
vi.mock("@/lib/ai-locate", () => ({
  asDoc: (raw: unknown) => (Array.isArray(raw) ? { type: "doc", content: raw } : raw),
  applyEditToDocJson: M.applyEditToDocJson,
}));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: { getState: () => M.workspaceState, subscribe: () => () => undefined },
}));
vi.mock("sonner", () => ({ toast: { error: M.toastError, success: M.toastSuccess } }));
vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

bindAiMocks(M);

describe("ai store：会话生命周期", () => {
  it("clear：按 id 删除当前会话的库行", async () => {
    const store = await loadStore();
    await completeTurn(store, "你好");
    const activeId = store.getState().activeSessionId;
    store.getState().clear();
    expect(store.getState().messages).toEqual([]);
    expect(M.aiSessionDelete).toHaveBeenCalledWith(activeId);
  });

  it("clear：空会话不触发删除", async () => {
    const store = await loadStore();
    store.getState().clear();
    expect(M.aiSessionDelete).not.toHaveBeenCalled();
  });

  it("newChat：归档当前会话；历史超过 20 条也不裁剪、不删除", async () => {
    const store = await loadConfiguredStore();
    const sessions = Array.from({ length: 20 }, (_, i) => session(20 - i)); // s20 最新 … s1 最老
    const oldActive = store.getState().activeSessionId;
    store.setState({ messages: [{ id: "u1", role: "user", content: "你好" }], sessions });
    store.getState().newChat();
    const s = store.getState();
    expect(s.messages).toEqual([]);
    // 全部保留：显示窗口由面板负责，数据一条不删
    expect(s.sessions).toHaveLength(21);
    expect(s.sessions[0].title).toBe("你好");
    expect(s.sessions.some((x) => x.id === "s1")).toBe(true);
    expect(M.aiSessionSave).toHaveBeenCalledTimes(1);
    expect(M.aiSessionSave.mock.calls[0][0]).toMatchObject({ id: oldActive });
    expect(M.aiSessionDelete).not.toHaveBeenCalled();
  });

  it("switchSession：当前对话先归档，目标会话载入", async () => {
    const store = await loadConfiguredStore();
    store.setState({
      messages: [{ id: "u1", role: "user", content: "当前问题" }],
      sessions: [session(1)],
    });
    store.getState().switchSession("s1");
    const s = store.getState();
    expect(s.activeSessionId).toBe("s1");
    expect(s.messages.map((m) => m.content)).toEqual(["问题1"]);
    // 只有刚归档的旧对话被 upsert，切入的目标会话不重复落库
    expect(M.aiSessionSave).toHaveBeenCalledTimes(1);
    expect(M.aiSessionSave.mock.calls[0][0]).toMatchObject({ title: "当前问题" });
  });

  it("流式进行中禁止切换/删除会话", async () => {
    const store = await loadConfiguredStore();
    store.setState({ sessions: [session(1)] });
    const { p, feed } = await startTurn(store, "q");
    store.getState().switchSession("s1");
    store.getState().deleteSession("s1");
    expect(store.getState().activeSessionId).not.toBe("s1");
    expect(store.getState().sessions).toHaveLength(1);
    feed({ type: "done", full: "ok" });
    await p;
    // 轮次结束后才允许删除
    store.getState().deleteSession("s1");
    expect(store.getState().sessions).toHaveLength(0);
    expect(M.aiSessionDelete).toHaveBeenCalledWith("s1");
  });

  it("loadSessions：优先从库恢复，首条为当前会话", async () => {
    const store = await loadStore();
    const row = {
      id: "db1",
      title: "库里会话",
      page_id: "p1",
      page_title: "页面",
      updated_at: "5",
      messages: JSON.stringify([{ id: "x", role: "user", content: "库里问题" }]),
    };
    M.aiSessionList.mockResolvedValue([row]);
    await store.getState().loadSessions();
    const s = store.getState();
    expect(s.activeSessionId).toBe("db1");
    expect(s.messages.map((m) => m.content)).toEqual(["库里问题"]);
    expect(s.sessionPageId).toBe("p1");
    expect(s.sessionsLoaded).toBe(true);
  });

  it("落库失败：回写 localStorage 兜底而不是丢历史", async () => {
    const store = await loadConfiguredStore();
    M.aiSessionSave.mockRejectedValue(new Error("db down"));
    const { p, feed } = await startTurn(store, "你好");
    feed({ type: "done", full: "回答" });
    await p;
    await vi.waitFor(() => {
      const raw = storage.get("tsflowy-ai-sessions-v1");
      expect(raw).toBeTruthy();
      expect(raw!.includes("你好")).toBe(true);
    });
  });

  /** 老版本（建表迁移未生效时）留在 localStorage 里的会话：一条当前对话 + 一条归档 */
  function seedLocalSessions() {
    storage.set(
      "tsflowy-ai-sessions-v1",
      JSON.stringify({
        active: { id: "a1", title: "当前", updatedAt: 9, messages: [{ id: "u1", role: "user", content: "老问题" }] },
        sessions: [
          { id: "b2", title: "归档", updatedAt: 8, messages: [{ id: "u2", role: "user", content: "更老的问题" }] },
        ],
      }),
    );
  }

  it("loadSessions：库空但本地有老会话时一次性导入库，成功后清掉本地副本", async () => {
    const store = await loadStore();
    seedLocalSessions();
    await store.getState().loadSessions();
    const s = store.getState();
    // 本地那份的当前会话保持在前，导入不会把用户正在看的对话换掉
    expect(s.activeSessionId).toBe("a1");
    expect(s.messages.map((m) => m.content)).toEqual(["老问题"]);
    expect(s.sessions.map((x) => x.id)).toEqual(["b2"]);
    expect(M.aiSessionSave.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["a1", "b2"]);
    // 本地副本必须删掉：留着它，下次库读取失败时会拿这份过期数据覆盖库里的新内容
    expect(storage.has("tsflowy-ai-sessions-v1")).toBe(false);
  });

  it("loadSessions：导入失败时保留本地副本，下次启动重试", async () => {
    const store = await loadStore();
    seedLocalSessions();
    M.aiSessionSave.mockRejectedValue(new Error("db down"));
    await store.getState().loadSessions();
    const s = store.getState();
    expect(s.messages.map((m) => m.content)).toEqual(["老问题"]);
    expect(s.sessions).toHaveLength(1);
    expect(storage.has("tsflowy-ai-sessions-v1")).toBe(true);
  });

  it("loadSessions：库里已有会话行就不再导入本地", async () => {
    const store = await loadStore();
    seedLocalSessions();
    M.aiSessionList.mockResolvedValue([
      {
        id: "db1",
        title: "库里会话",
        page_id: null,
        page_title: null,
        updated_at: "5",
        messages: JSON.stringify([{ id: "x", role: "user", content: "库里问题" }]),
      },
    ]);
    await store.getState().loadSessions();
    expect(store.getState().activeSessionId).toBe("db1");
    expect(M.aiSessionSave).not.toHaveBeenCalled();
  });
});

describe("ai store：动作卡片随会话恢复", () => {
  /** 落库的会话行里带一张待确认的改文档卡片（revert 只活在内存，恢复时不该带回来） */
  function actionRow(pageId: string | null) {
    return {
      id: "db1",
      title: "会话",
      page_id: pageId,
      page_title: "页面",
      updated_at: "5",
      messages: JSON.stringify([
        { id: "u1", role: "user", content: "改一下" },
        {
          id: "a1",
          role: "assistant",
          content: "回答",
          actions: [
            {
              tool: "apply_edit",
              call: { tool: "apply_edit", args: { op: "append_to_document", summary: "补一段", content: "新内容" } },
              op: "append_to_document",
              summary: "补一段",
              content: "新内容",
              before: "旧内容",
              state: "pending",
              revert: { kind: "editor-transaction" },
            },
          ],
        },
      ]),
    };
  }

  it("待确认卡片原样恢复，并钉回会话发起的那一页", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([actionRow("p1")]);
    await store.getState().loadSessions();
    const rec = store.getState().messages[1].actions![0];
    expect(rec).toMatchObject({
      tool: "apply_edit",
      op: "append_to_document",
      state: "pending",
      summary: "补一段",
      content: "新内容",
      before: "旧内容",
      call: { tool: "apply_edit", args: { op: "append_to_document", view_id: "p1" } },
    });
    // 不恢复 revert：重启后编辑器 undo 栈已空，跨会话撤销会错伤无关内容
    expect(rec).not.toHaveProperty("revert");
    // 恢复只重建卡片，不会替用户把改动写进文档
    expect(M.applyEdit).not.toHaveBeenCalled();
    expect(M.runWriteAction).not.toHaveBeenCalled();
  });

  it("表数据动作的逆操作计划随会话恢复：重启后这张卡片仍然撤得动", async () => {
    const store = await loadStore();
    const row = actionRow("p1");
    row.messages = JSON.stringify([
      { id: "u1", role: "user", content: "加一行" },
      {
        id: "a1",
        role: "assistant",
        content: "回答",
        actions: [
          {
            tool: "add_database_row",
            call: { tool: "add_database_row", args: { database: "任务" } },
            op: null,
            summary: "在「任务」新增一行",
            content: "",
            before: "",
            state: "applied",
            detail: "已新增一行",
            undo: { kind: "purge_row", database: "v1", row_id: "r9" },
          },
        ],
      },
    ]);
    M.aiSessionList.mockResolvedValue([row]);
    await store.getState().loadSessions();
    expect(store.getState().messages[1].actions![0].undo).toEqual({ kind: "purge_row", database: "v1", row_id: "r9" });
    await store.getState().undoAction("a1", 0);
    expect(M.runUndoPlan).toHaveBeenCalledWith({ kind: "purge_row", database: "v1", row_id: "r9" });
    expect(store.getState().messages[1].actions![0].undone).toBe(true);
  });

  it("会话没有关联页面：不补 view_id，应用时仍按当前打开的文档处理", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([actionRow(null)]);
    await store.getState().loadSessions();
    expect(store.getState().messages[1].actions![0].call).not.toHaveProperty("args.view_id");
  });

  it("已执行/已忽略/格式有误都能恢复；脏数据卡片被丢弃", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      {
        id: "db2",
        title: "混合",
        page_id: null,
        page_title: null,
        updated_at: "6",
        messages: JSON.stringify([
          {
            id: "a1",
            role: "assistant",
            content: "回答",
            actions: [
              {
                tool: "create_page",
                call: { tool: "create_page", args: { title: "新页", content: "正文" } },
                op: null,
                summary: "新建页面「新页」",
                content: "正文",
                before: "",
                state: "applied",
                undone: true,
                detail: "已新建页面",
              },
              {
                tool: "set_page_title",
                call: { tool: "set_page_title", args: { page: "旧名", title: "新名" } },
                op: null,
                summary: "",
                content: "",
                before: "",
                state: "rejected",
              },
              { tool: "invalid", call: null, op: null, summary: "", content: "", before: "", state: "malformed" },
              // 检索调用不产生卡片、状态不在枚举里的一律丢弃
              {
                tool: "search_workspace",
                call: { tool: "search_workspace", args: { query: "x" } },
                op: null,
                summary: "",
                content: "",
                before: "",
                state: "pending",
              },
              {
                tool: "create_page",
                call: { tool: "create_page", args: { title: "T" } },
                op: null,
                summary: "",
                content: "",
                before: "",
                state: "someday",
              },
            ],
          },
        ]),
      },
    ]);
    await store.getState().loadSessions();
    const actions = store.getState().messages[0].actions!;
    expect(actions.map((a) => [a.tool, a.state])).toEqual([
      ["create_page", "applied"],
      ["set_page_title", "rejected"],
      ["invalid", "malformed"],
    ]);
    expect(actions[0]).toMatchObject({ undone: true, detail: "已新建页面" });
    expect(actions[1]).not.toHaveProperty("undone");
  });

  it("库为空时走本地兜底：兜底里的卡片同样恢复", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([]);
    storage.set(
      "tsflowy-ai-sessions-v1",
      JSON.stringify({
        activeId: "l1",
        sessions: [],
        active: {
          id: "l1",
          title: "本地会话",
          updatedAt: 1,
          pageId: "lp",
          messages: [
            { id: "u1", role: "user", content: "改一下" },
            {
              id: "a1",
              role: "assistant",
              content: "回答",
              actions: [
                {
                  tool: "create_page",
                  call: { tool: "create_page", args: { title: "新页", content: "正文" } },
                  op: null,
                  summary: "新建页面「新页」",
                  content: "正文",
                  before: "",
                  state: "pending",
                },
              ],
            },
          ],
        },
      }),
    );
    await store.getState().loadSessions();
    const s = store.getState();
    expect(s.activeSessionId).toBe("l1");
    expect(s.messages[1].actions![0]).toMatchObject({ tool: "create_page", state: "pending" });
  });
});

describe("ai store：消息级操作", () => {
  it("regenerate：丢掉这条回答与其后的消息，用原问题再问一次", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "第一问", "第一答");
    await completeTurn(store, "第二问", "第二答");
    const firstAssistantId = store.getState().messages[1].id;
    const before = streamHandlers.length;
    const p = store.getState().regenerate(firstAssistantId);
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([{ type: "done", full: "重写的答案" }]);
    await p;
    const s = store.getState();
    expect(s.messages.map((m) => m.content)).toEqual(["第一问", "重写的答案"]);
    // 第二问整轮不再进入请求，重问用的是第一条提问
    const outgoing = M.aiChat.mock.calls[M.aiChat.mock.calls.length - 1][0] as AiChatMessage[];
    expect(outgoing.filter((m) => m.role !== "system").map((m) => m.content)).toEqual(["第一问"]);
  });

  it("regenerate：只对助手回答生效，流式进行中不动作", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "第一问", "第一答");
    const userId = store.getState().messages[0].id;
    void store.getState().regenerate(userId);
    expect(streamHandlers).toHaveLength(1);
    expect(store.getState().messages.map((m) => m.content)).toEqual(["第一问", "第一答"]);

    const p = store.getState().send("进行中");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(2));
    void store.getState().regenerate(store.getState().messages[1].id);
    expect(store.getState().streaming).toBe(true);
    pump([{ type: "done", full: "ok" }]);
    await p;
  });

  it("resend：替换提问正文，丢掉它之后的消息并重新生成", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "原问题", "原回答");
    await completeTurn(store, "另一个问题", "另一个回答");
    const userId = store.getState().messages[0].id;
    store.getState().startEdit(userId);
    expect(store.getState().editingId).toBe(userId);
    const p = store.getState().resend(userId, "改过的问题");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(3));
    pump([{ type: "done", full: "新回答" }]);
    await p;
    const s = store.getState();
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "改过的问题"],
      ["assistant", "新回答"],
    ]);
    expect(s.editingId).toBeNull();
    const outgoing = M.aiChat.mock.calls[M.aiChat.mock.calls.length - 1][0] as AiChatMessage[];
    expect(outgoing.filter((m) => m.role !== "system").map((m) => m.content)).toEqual(["改过的问题"]);
  });

  it("resend：空白内容与流式进行中都不发送", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "第一问", "第一答");
    const userId = store.getState().messages[0].id;
    const before = streamHandlers.length;
    await store.getState().resend(userId, "   ");
    expect(streamHandlers).toHaveLength(before);
    expect(store.getState().messages.map((m) => m.content)).toEqual(["第一问", "第一答"]);
  });

  it("startEdit：只标记用户消息，cancelEdit 复位", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "第一问", "第一答");
    const [userId, assistantId] = store.getState().messages.map((m) => m.id);
    store.getState().startEdit(assistantId);
    expect(store.getState().editingId).toBeNull();
    store.getState().startEdit(userId);
    expect(store.getState().editingId).toBe(userId);
    // 普通提问（快捷动作也走它）会作废待修改的标记
    await completeTurn(store, "另一个问题", "另一个回答");
    expect(store.getState().editingId).toBeNull();
    store.getState().startEdit(userId);
    store.getState().cancelEdit();
    expect(store.getState().editingId).toBeNull();
  });

  it("branchFrom：当前对话整段归档，前缀成为一个新会话", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "第一问", "第一答");
    await completeTurn(store, "第二问", "第二答");
    const oldId = store.getState().activeSessionId;
    store.getState().branchFrom(store.getState().messages[1].id);
    const s = store.getState();
    expect(s.activeSessionId).not.toBe(oldId);
    expect(s.messages.map((m) => m.content)).toEqual(["第一问", "第一答"]);
    expect(s.sessions.map((x) => x.id)).toContain(oldId);
    expect(s.sessions.find((x) => x.id === oldId)!.messages.map((m) => m.content)).toEqual([
      "第一问",
      "第一答",
      "第二问",
      "第二答",
    ]);
    // 归档的旧会话与新建的分支会话都落库
    expect(M.aiSessionSave).toHaveBeenCalledWith(expect.objectContaining({ id: oldId }));
    expect(M.aiSessionSave).toHaveBeenCalledWith(expect.objectContaining({ id: s.activeSessionId }));
  });

  it("saveMessageAsPage：按回答首行取标题，正文整段落成新页", async () => {
    const store = await loadConfiguredStore();
    const content = "# 周会纪要\n决议 A\n决议 B";
    await completeTurn(store, "写份纪要", content);
    await store.getState().saveMessageAsPage(store.getState().messages[1].id);
    expect(M.runWriteAction).toHaveBeenCalledWith({ tool: "create_page", args: { title: "周会纪要", content } });
    expect(M.toastSuccess).toHaveBeenCalled();
  });

  it("refinePrompt：候选去掉编号引号并去重，与原提问相同的不列", async () => {
    const store = await loadConfiguredStore();
    const p = store.getState().refinePrompt("总结会议");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    pump([
      {
        type: "done",
        full:
          "1. 把最近三周的会议记录按待办汇总\n- 「列出每周会议记录里的风险点」\n- 总结会议\n\n\n超过三百字的那条：" +
          "y".repeat(300),
      },
    ]);
    await p;
    const s = store.getState();
    expect(s.promptIdeas).toEqual(["把最近三周的会议记录按待办汇总", "列出每周会议记录里的风险点"]);
    expect(s.refining).toBe(false);
    // 改写不进对话
    expect(s.messages).toEqual([]);
    const outgoing = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    expect(outgoing.map((m) => m.role)).toEqual(["system", "user"]);
    // 新一轮提问会把候选清掉
    await completeTurn(store, "换话题", "回答");
    expect(store.getState().promptIdeas).toEqual([]);
  });

  it("refinePrompt：请求失败只弹提示，不污染对话错误态", async () => {
    const store = await loadConfiguredStore({ chatThrows: true });
    await store.getState().refinePrompt("总结会议");
    expect(store.getState().promptIdeas).toEqual([]);
    expect(store.getState().refining).toBe(false);
    expect(store.getState().error).toBeNull();
    expect(M.toastError).toHaveBeenCalled();
  });

  it("refinePrompt：模型没给出可用候选时提示用户", async () => {
    const store = await loadConfiguredStore();
    const p = store.getState().refinePrompt("总结会议");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    pump([{ type: "done", full: "总结会议" }]);
    await p;
    expect(store.getState().promptIdeas).toEqual([]);
    expect(M.toastError).toHaveBeenCalledWith("ai.refineNone");
  });

  it("清空/新会话/切换会话都会复位「改后重发」与候选", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "第一问", "第一答");
    const userId = store.getState().messages[0].id;
    store.getState().startEdit(userId);
    store.setState({ promptIdeas: ["候选"], sessions: [session(1)] });
    store.getState().switchSession("s1");
    expect(store.getState().editingId).toBeNull();
    expect(store.getState().promptIdeas).toEqual([]);
    await completeTurn(store, "第二问", "第二答");
    store.getState().startEdit(store.getState().messages[0].id);
    store.getState().newChat();
    expect(store.getState().editingId).toBeNull();
    store.getState().startEdit("any");
    store.getState().clear();
    expect(store.getState().editingId).toBeNull();
  });
});

describe("ai store：会话归档、改名与回答评分", () => {
  /** 直接造库行，跳过落库流程单独验证读取侧 */
  function row(id: string, opts: { updatedAt: number; archived?: boolean; title?: string; content?: string }) {
    return {
      id,
      title: opts.title ?? `会话${id}`,
      page_id: null,
      page_title: null,
      updated_at: String(opts.updatedAt),
      messages: JSON.stringify([{ id: `m-${id}`, role: "user", content: opts.content ?? `问题${id}` }]),
      prompt_tokens: 0,
      completion_tokens: 0,
      archived: opts.archived ?? false,
    };
  }

  it("当前会话取最近一条未归档的，归档项留在历史列表里", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      row("a1", { updatedAt: 30, archived: true }),
      row("n1", { updatedAt: 20 }),
      row("n2", { updatedAt: 10 }),
    ]);
    await store.getState().loadSessions();
    expect(store.getState().activeSessionId).toBe("n1");
    expect(store.getState().sessions.map((x) => x.id)).toEqual(["a1", "n2"]);
  });

  it("归档写入整行覆盖：archived 位随会话行落库", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([row("cur", { updatedAt: 9 }), row("old", { updatedAt: 8 })]);
    await store.getState().loadSessions();
    store.getState().setSessionArchived("old", true);
    const saved = M.aiSessionSave.mock.calls[M.aiSessionSave.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(saved).toMatchObject({ id: "old", archived: true });
    expect(store.getState().sessions.find((x) => x.id === "old")?.archived).toBe(true);
  });

  it("会话多于显示窗口：库里全部保留，窗口只管展示，加载更多逐步放量", async () => {
    const store = await loadStore();
    const many = Array.from({ length: 30 }, (_, i) => row(`p${i}`, { updatedAt: 100 - i }));
    M.aiSessionList.mockResolvedValue([
      row("cur", { updatedAt: 200 }),
      ...many,
      row("arch", { updatedAt: 1, archived: true }),
    ]);
    await store.getState().loadSessions();
    const s = store.getState();
    // 31 条历史全部进 sessions（不再按 21 条截断），且没有任何删除
    expect(s.sessions).toHaveLength(31);
    expect(M.aiSessionDelete).not.toHaveBeenCalled();
    expect(s.sessionsShown).toBe(20);

    const { visibleSessionWindow } = await import("@/stores/ai");
    const windowed = visibleSessionWindow(s.sessions, s.sessionsShown);
    // 归档不受窗口限制；普通会话按序取前 20 条
    expect(windowed).toHaveLength(21);
    expect(windowed.some((x) => x.id === "arch")).toBe(true);
    expect(windowed.some((x) => x.id === "p19")).toBe(true);
    expect(windowed.some((x) => x.id === "p20")).toBe(false);

    store.getState().loadMoreSessions();
    expect(store.getState().sessionsShown).toBe(40);
    expect(visibleSessionWindow(store.getState().sessions, store.getState().sessionsShown)).toHaveLength(31);
  });

  it("改名：整行重写新标题，空标题忽略", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([row("cur", { updatedAt: 9 }), row("old", { updatedAt: 8 })]);
    await store.getState().loadSessions();
    store.getState().renameSession("old", "  改过的标题  ");
    const saved = M.aiSessionSave.mock.calls[M.aiSessionSave.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(saved).toMatchObject({ id: "old", title: "改过的标题" });
    const before = M.aiSessionSave.mock.calls.length;
    store.getState().renameSession("old", "   ");
    expect(M.aiSessionSave).toHaveBeenCalledTimes(before);
  });

  it("评分：点赞写入消息并落盘，再点同向取消", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "你好");
    const assistantId = store.getState().messages[1].id;
    store.getState().rateMessage(assistantId, "up");
    expect(store.getState().messages[1].rating).toBe("up");
    expect(M.aiSessionSave).toHaveBeenCalled();
    store.getState().rateMessage(assistantId, "down");
    expect(store.getState().messages[1].rating).toBe("down");
    store.getState().rateMessage(assistantId, "down");
    expect(store.getState().messages[1].rating).toBeUndefined();
  });

  it("恢复会话时保留评分，畸形值丢弃", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      {
        id: "rated",
        title: "评过分",
        page_id: null,
        page_title: null,
        updated_at: "9",
        archived: false,
        prompt_tokens: 0,
        completion_tokens: 0,
        messages: JSON.stringify([
          { id: "u1", role: "user", content: "问题" },
          { id: "a1", role: "assistant", content: "回答", rating: "up" },
          { id: "a2", role: "assistant", content: "回答二", rating: "不错" },
        ]),
      },
    ]);
    await store.getState().loadSessions();
    const [a1, a2] = store.getState().messages.slice(1);
    expect(a1.rating).toBe("up");
    expect(a2.rating).toBeUndefined();
  });

  it("重新生成会产生新的助手消息：评分留在原那条上", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "你好");
    const first = store.getState().messages[1];
    store.getState().rateMessage(first.id, "up");
    await completeTurn(store, "再答一次");
    expect(store.getState().messages.some((m) => m.id === first.id && m.rating === "up")).toBe(true);
  });
});
