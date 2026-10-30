// AI store 单测（按主题拆自 `ai.test.ts`）：流式问答与 agent 循环：一轮请求的事件编排、编辑指令落地、停止竞态与上下文预算截断。
// 桩包必须每个测试文件各造一份：`vi.mock` 与 `vi.hoisted` 由 vitest 提到本文件的 import 之前，跨文件复用会踩空，
// 所以只有 mock 表各留一份，其余骨架（helper、根级 beforeEach、localStorage 替身）共用 `test/ai-store-harness.ts`。
import { describe, expect, it, vi } from "vitest";
import type { AiChatMessage } from "@/lib/ai";
import {
  bindAiMocks,
  EDIT_FULL,
  completeTurn,
  defaultConfig,
  loadConfiguredStore,
  loadStore,
  pump,
  startTurn,
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
vi.mock("@/lib/ai/ai-editor", () => ({ getAiEditor: M.getAiEditor, getAiEditorForView: M.getAiEditorForView }));
vi.mock("@/lib/backend/db", () => ({ newId: M.newId }));
vi.mock("@/lib/doc/documents", () => ({ documentApi: { get: M.documentGet, save: M.documentSave } }));
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
vi.mock("@/lib/ai/ai-locate", () => ({
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

describe("ai store：一轮问答", () => {
  it("send 走通：消息落位、outgoing 含 system 与本轮提问、结束后按条落库", async () => {
    const store = await loadConfiguredStore();
    const outgoing = await completeTurn(store, "你好");
    const s = store.getState();
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1].content).toBe("回答");
    expect(s.streaming).toBe(false);
    expect(outgoing[0].role).toBe("system");
    expect(outgoing[outgoing.length - 1]).toEqual({ role: "user", content: "你好" });
    // 落库两次：用户消息先行 + 一轮收尾快照（都是当前会话这一条，不再整表覆盖）
    expect(M.aiSessionSave).toHaveBeenCalledTimes(2);
    expect(M.aiSessionSave.mock.calls[0][0]).toMatchObject({ id: s.activeSessionId });
  });

  // send 里那句 `messages.length === 0 ? currentPageRef() : null` 与 run-slice 顶部的 currentPageRef：
  // 会话列表靠这两个值标注「这一问是在哪一页发起的」，没有断言的话搬动它等于没验。
  it("会话首条提问标注发起时所在页面，之后的提问不再改标", async () => {
    const store = await loadConfiguredStore();
    M.workspaceState.currentViewId = "v-report";
    M.workspaceState.tree = [{ id: "v-report", name: "周报", layout: "document", children: [] }];
    await completeTurn(store, "第一问");
    expect(store.getState().sessionPageId).toBe("v-report");
    expect(store.getState().sessionPageTitle).toBe("周报");

    M.workspaceState.currentViewId = "v-other";
    await completeTurn(store, "第二问");
    expect(store.getState().sessionPageId).toBe("v-report");
  });

  it("停止后迟到的 done 帧带编辑指令：停在待确认，不自动写文档", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "chunk", delta: "回答" });
    store.getState().stop();
    expect(M.aiCancel).toHaveBeenCalled();
    feed({ type: "done", full: EDIT_FULL });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.actions?.[0].state).toBe("pending");
    expect(M.applyEdit).not.toHaveBeenCalled();
  });

  // 上面那条在 `confirm_edit` 默认开着时成立，两条路都会停在待确认，看不出「轮次登记」有没有生效：
  // 这条把确认关掉，只剩「这一轮被用户停过」这一个理由能拦住自动落地，才真正盯住 run-slice 与
  // stream-slice 之间共享的那个被停轮号集合。
  it("确认关闭时迟到的 done 仍不写数据：拦它的是轮次登记，不是 confirm_edit", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "chunk", delta: "回答" });
    store.getState().stop();
    feed({ type: "done", full: EDIT_FULL });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.actions?.[0].state).toBe("pending");
    expect(M.applyEdit).not.toHaveBeenCalled();
  });

  it("confirm_edit 关闭时 done 带编辑指令：直接落地为 applied", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "done", full: EDIT_FULL });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.actions?.[0].state).toBe("applied");
    expect(M.applyEdit).toHaveBeenCalledWith("append_to_document", "新内容", undefined);
    expect(msg.content).toBe("回答");
  });

  it("没有打开文档时编辑指令标记为 unavailable", async () => {
    const store = await loadConfiguredStore({ bridgeNull: true });
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "done", full: EDIT_FULL });
    await p;
    expect(store.getState().messages[1].actions?.[0].state).toBe("unavailable");
  });

  it("编辑指令块格式不对：正文剥掉坏块，卡片标记 malformed", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "q");
    feed({ type: "done", full: "回答\n\n```tsflowy-edit\n{坏 json}\n```" });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.content).toBe("回答");
    expect(msg.actions?.[0].state).toBe("malformed");
    expect(M.applyEdit).not.toHaveBeenCalled();
  });

  it("cancelled 尾帧：保留已生成的半截回答，不计为错误", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "q");
    feed({ type: "chunk", delta: "写了一半" });
    await vi.waitFor(() => expect(store.getState().messages[1].content).toBe("写了一半"));
    feed({ type: "error", message: "cancelled", code: "cancelled" });
    await p;
    const s = store.getState();
    expect(s.messages[1].content).toBe("写了一半");
    expect(s.error).toBeNull();
  });

  it("错误事件：空助手占位移除，错误与归类码入状态", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "q");
    feed({ type: "error", message: "余额不足", code: "quota" });
    await p;
    const s = store.getState();
    expect(s.messages).toHaveLength(1);
    expect(s.error).toBe("余额不足");
    expect(s.errorCode).toBe("quota");
  });

  it("起手就抛错：无归类码，占位移除", async () => {
    const store = await loadConfiguredStore({ chatThrows: true });
    await store.getState().send("q");
    const s = store.getState();
    expect(s.messages).toHaveLength(1);
    expect(s.error).toBe("boom");
    expect(s.errorCode).toBeNull();
  });
});

describe("ai store：agent 多步循环", () => {
  const callBlock = (json: string) => `\`\`\`tsflowy-call\n${json}\n\`\`\``;

  it("文本协议检索块：本机执行后把结果喂回下一轮，答案取最后一轮", async () => {
    const store = await loadConfiguredStore();
    const p = store.getState().send("我上周记的评审结论是什么？");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    const ask = `先查一下。\n\n${callBlock('{"tool":"search_workspace","args":{"query":"评审"}}')}`;
    streamHandlers[0]({ type: "done", full: ask });
    await vi.waitFor(() => expect(streamHandlers.length).toBe(2));
    expect(M.runRetrievalCall).toHaveBeenCalledWith("search_workspace", { query: "评审" }, 8000);
    const second = M.aiChat.mock.calls[1][0] as AiChatMessage[];
    // 文本协议模式没有 tool 消息通道：结果作为一条 system 回灌，且带上模型上一轮的原文
    expect(second[second.length - 2]).toMatchObject({ role: "assistant", content: ask });
    expect(second[second.length - 1]?.content).toContain("【检索结果】");
    streamHandlers[1]({ type: "done", full: "评审结论是通过" });
    await p;
    const msg = store.getState().messages[1];
    // 第一轮那句「先查一下」不算答案，不该和最终回答叠在一起
    expect(msg.content).toBe("评审结论是通过");
    expect(msg.actions).toBeUndefined();
  });

  it("use_tools 打开时：检索结果按 assistant.tool_calls + role=tool 回灌", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ use_tools: true }) });
    const p = store.getState().send("列一下页面");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    streamHandlers[0]({
      type: "done",
      full: "",
      tool_calls: [{ id: "c1", name: "list_pages", arguments: "{}" }],
    });
    await vi.waitFor(() => expect(streamHandlers.length).toBe(2));
    const second = M.aiChat.mock.calls[1][0] as AiChatMessage[];
    expect(second[second.length - 2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", function: { name: "list_pages" } }],
    });
    expect(second[second.length - 1]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "检索桩结果" });
    streamHandlers[1]({ type: "done", full: "一共三页" });
    await p;
    expect(store.getState().messages[1].content).toBe("一共三页");
  });

  it("检索轮次到达上限：剩下的请求不执行，正文后写明", async () => {
    const store = await loadConfiguredStore();
    const p = store.getState().send("一直查");
    for (let round = 0; round < 4; round++) {
      await vi.waitFor(() => expect(streamHandlers.length).toBe(round + 1));
      streamHandlers[round]({ type: "done", full: `第${round}轮\n\n${callBlock('{"tool":"list_pages","args":{}}')}` });
    }
    await p;
    // 前 3 轮的结果还能进下一轮提问，第 4 轮再要求检索已经没有下一次了
    expect(M.runRetrievalCall).toHaveBeenCalledTimes(3);
    const msg = store.getState().messages[1];
    expect(msg.content).toContain("第3轮");
    expect(msg.content).toContain("ai.searchRoundLimit");
  });

  it("轮次上限取自配置：agent_rounds=2 时只跑两轮就收尾", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ agent_rounds: 2 }) });
    const p = store.getState().send("一直查");
    for (let round = 0; round < 2; round++) {
      await vi.waitFor(() => expect(streamHandlers.length).toBe(round + 1));
      streamHandlers[round]({ type: "done", full: `第${round}轮\n\n${callBlock('{"tool":"list_pages","args":{}}')}` });
    }
    await p;
    // 只有第 1 轮的检索有机会进下一轮提问
    expect(M.runRetrievalCall).toHaveBeenCalledTimes(1);
    const msg = store.getState().messages[1];
    expect(msg.content).toContain("第1轮");
    expect(msg.content).toContain("ai.searchRoundLimit");
  });

  it("首轮报上下文超限：砍半预算自动补发一次", async () => {
    const store = await loadConfiguredStore();
    const p = store.getState().send("q");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    streamHandlers[0]({ type: "chunk", delta: "半截答案" });
    await vi.waitFor(() => expect(store.getState().messages[1].content).toBe("半截答案"));
    streamHandlers[0]({ type: "error", message: "上下文超长", code: "context_length" });
    await vi.waitFor(() => expect(streamHandlers.length).toBe(2));
    streamHandlers[1]({ type: "done", full: "重发后的答案" });
    await p;
    const s = store.getState();
    expect(s.error).toBeNull();
    // 默认预算 3000 → 补发用 1500；重发前那句半截答案不能留在正文里
    expect(s.messages[1].content).toContain("重发后的答案");
    expect(s.messages[1].content).not.toContain("半截答案");
    expect(s.messages[1].content).toContain("ai.contextBudgetRetried");
    expect(s.messages[1].actions).toBeUndefined();
  });

  it("超限补发后仍超限：报错照旧交给用户，不无限重试", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_token_budget: 800 }) });
    const p = store.getState().send("q");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    // 800 砍半是 400，低于 500 token 的下限：不值得再试，直接报错
    streamHandlers[0]({ type: "error", message: "上下文超长", code: "context_length" });
    await p;
    expect(M.aiChat).toHaveBeenCalledTimes(1);
    expect(store.getState().errorCode).toBe("context_length");
  });

  it("多个写动作各一张卡片：确认其中一个不影响其它", async () => {
    const store = await loadConfiguredStore();
    const full = [
      "已安排。",
      '```tsflowy-edit\n{"tool":"apply_edit","args":{"op":"append_to_document","summary":"补一段","content":"新内容"}}\n```',
      '```tsflowy-edit\n{"tool":"create_page","args":{"title":"会议纪要"}}\n```',
    ].join("\n\n");
    const { p, feed } = await startTurn(store, "补一段并新建纪要页");
    feed({ type: "done", full });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.actions?.map((a) => a.tool)).toEqual(["apply_edit", "create_page"]);
    expect(msg.actions?.every((a) => a.state === "pending")).toBe(true);
    await store.getState().applyAction(msg.id, 1);
    expect(M.runWriteAction).toHaveBeenCalledWith({ tool: "create_page", args: { title: "会议纪要" } });
    const after = store.getState().messages[1].actions!;
    expect(after[0].state).toBe("pending");
    expect(after[1].state).toBe("applied");
  });

  it("apply_edit 带 view_id：走 JSON 路径写库，不碰当前编辑器", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    M.workspaceState.currentViewId = "here";
    M.resolvePage.mockImplementation(() => ({ id: "other", name: "另一页", layout: "document" }));
    M.applyEditToDocJson.mockImplementation(() => ({ ok: true, content: [], before: "旧内容" }));
    const full =
      '改好了\n\n```tsflowy-edit\n{"tool":"apply_edit","args":{"op":"replace_under_heading","summary":"重写背景","content":"新内容","anchor":{"heading":"背景"},"view_id":"other"}}\n```';
    const { p, feed } = await startTurn(store, "把另一页的背景重写");
    feed({ type: "done", full });
    await p;
    const rec = store.getState().messages[1].actions![0];
    expect(rec.state).toBe("applied");
    expect(rec.pageName).toBe("另一页");
    expect(rec.before).toBe("旧内容");
    expect(M.applyEdit).not.toHaveBeenCalled();
    expect(M.documentSave).toHaveBeenCalledWith("other", expect.any(String));
  });

  it("撤销按动作下标生效", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "done", full: EDIT_FULL });
    await p;
    const msg = store.getState().messages[1];
    await store.getState().undoAction(msg.id, 0);
    expect(M.undoAiEdit).toHaveBeenCalled();
    expect(store.getState().messages[1].actions![0].undone).toBe(true);
  });

  it("表数据写动作记下逆操作计划，撤销按数据回滚而不是碰编辑器", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    M.resolvePage.mockImplementation(() => ({ id: "v1", name: "任务", layout: "table" }));
    const plan = { kind: "purge_row", database: "v1", row_id: "r9" };
    M.runWriteAction.mockImplementation(() => Promise.resolve({ ok: true, detail: "已加一行", undo: plan }));
    const { p, feed } = await startTurn(store, "加一行");
    feed({
      type: "done",
      full: `好\n\n\`\`\`tsflowy-edit\n{"tool":"add_database_row","args":{"database":"任务"}}\n\`\`\``,
    });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.actions![0].state).toBe("applied");
    expect(msg.actions![0].undo).toEqual(plan);
    await store.getState().undoAction(msg.id, 0);
    expect(M.runUndoPlan).toHaveBeenCalledWith(plan);
    expect(store.getState().messages[1].actions![0].undone).toBe(true);
    expect(M.undoAiEdit).not.toHaveBeenCalled();
  });

  it("逆操作执行失败：不标记已撤销，把原因反馈给用户", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    M.resolvePage.mockImplementation(() => ({ id: "v1", name: "任务", layout: "table" }));
    M.runWriteAction.mockImplementation(() =>
      Promise.resolve({ ok: true, detail: "已加一行", undo: { kind: "purge_row", database: "v1", row_id: "r9" } }),
    );
    const { p, feed } = await startTurn(store, "加一行");
    feed({
      type: "done",
      full: `好\n\n\`\`\`tsflowy-edit\n{"tool":"add_database_row","args":{"database":"任务"}}\n\`\`\``,
    });
    await p;
    M.runUndoPlan.mockImplementation(() => Promise.resolve({ ok: false, detail: "那一行已经不在回收站里了" }));
    const msg = store.getState().messages[1];
    await store.getState().undoAction(msg.id, 0);
    expect(M.toastError).toHaveBeenCalledWith("那一行已经不在回收站里了");
    expect(store.getState().messages[1].actions![0].undone).toBeUndefined();
  });
});

describe("ai store：停止取消与重试", () => {
  const callBlock = (json: string) => `\`\`\`tsflowy-call\n${json}\n\`\`\``;

  /** 手动放行的检索桩：复现「检索/工具执行阶段没有飞行中请求，aiCancel 够不着」的窗口 */
  function deferredRetrieval() {
    let release: (v: string) => void = () => undefined;
    M.runRetrievalCall.mockImplementation(
      () =>
        new Promise<string>((r) => {
          release = r;
        }),
    );
    return () => release("检索桩结果");
  }

  it("检索阶段点停止：不再发起下一轮请求，保留已产出内容并标记 stopped", async () => {
    const store = await loadConfiguredStore();
    const release = deferredRetrieval();
    const p = store.getState().send("我上周记的评审结论是什么？");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    streamHandlers[0]({ type: "chunk", delta: "先查一下。" });
    streamHandlers[0]({
      type: "done",
      full: `先查一下。\n\n${callBlock('{"tool":"search_workspace","args":{"query":"评审"}}')}`,
    });
    await vi.waitFor(() => expect(M.runRetrievalCall).toHaveBeenCalledTimes(1));
    store.getState().stop();
    release();
    await p;
    const s = store.getState();
    // 停止后 agent 循环必须自行在边界退出，而不是接着发起第二轮
    expect(M.aiChat).toHaveBeenCalledTimes(1);
    expect(s.streaming).toBe(false);
    expect(s.retrieving).toBe(false);
    expect(s.error).toBeNull();
    expect(s.messages[1].content).toBe("先查一下。");
    expect(s.messages[1].incomplete).toBe("stopped");
  });

  it("停止后不再执行剩余的检索步骤", async () => {
    const store = await loadConfiguredStore();
    let tick = 0;
    let release: (v: string) => void = () => undefined;
    M.runRetrievalCall.mockImplementation(() => {
      tick++;
      if (tick === 1) {
        return new Promise<string>((r) => {
          release = r;
        });
      }
      return Promise.resolve("检索桩结果");
    });
    const p = store.getState().send("一次查两样");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    streamHandlers[0]({
      type: "done",
      full: `查。\n\n${callBlock('{"tool":"search_workspace","args":{"query":"a"}}')}\n\n${callBlock('{"tool":"list_pages","args":{}}')}`,
    });
    await vi.waitFor(() => expect(M.runRetrievalCall).toHaveBeenCalledTimes(1));
    store.getState().stop();
    release("第一项结果");
    await p;
    expect(M.runRetrievalCall).toHaveBeenCalledTimes(1);
    expect(M.aiChat).toHaveBeenCalledTimes(1);
    // 本轮没产出任何正文：空的助手占位被丢弃，不留诡异空 bubble
    expect(store.getState().messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("停止后立刻重新提问：旧循环的收尾不影响新一轮流式", async () => {
    const store = await loadConfiguredStore();
    const release = deferredRetrieval();
    const p1 = store.getState().send("第一问");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    streamHandlers[0]({ type: "chunk", delta: "先查。" });
    streamHandlers[0]({ type: "done", full: `先查。\n\n${callBlock('{"tool":"list_pages","args":{}}')}` });
    await vi.waitFor(() => expect(M.runRetrievalCall).toHaveBeenCalledTimes(1));
    store.getState().stop();
    // 旧循环还挂在检索 await 上时发起新提问
    const p2 = store.getState().send("第二问");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(2));
    release();
    await p1;
    // 旧轮 finally 不得把新轮的 streaming 置回 false，也不得偷发起第二轮
    expect(store.getState().streaming).toBe(true);
    expect(streamHandlers).toHaveLength(2);
    pump([
      { type: "chunk", delta: "第二问的回答" },
      { type: "done", full: "第二问的回答" },
    ]);
    await p2;
    const s = store.getState();
    expect(s.streaming).toBe(false);
    expect(s.messages.map((m) => m.content)).toEqual(["第一问", "先查。", "第二问", "第二问的回答"]);
    expect(s.messages[1].incomplete).toBe("stopped");
    expect(M.aiChat).toHaveBeenCalledTimes(2);
  });

  it("retry：半截失败的回答被丢弃，重发同一个问题", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "q");
    feed({ type: "chunk", delta: "写了一半" });
    await vi.waitFor(() => expect(store.getState().messages[1].content).toBe("写了一半"));
    feed({ type: "error", message: "请求超时", code: "timeout" });
    await p;
    expect(store.getState().error).toBe("请求超时");
    expect(store.getState().messages[1].incomplete).toBe("error");
    const before = streamHandlers.length;
    const pr = store.getState().retry();
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([{ type: "done", full: "完整回答" }]);
    await pr;
    const s = store.getState();
    expect(s.error).toBeNull();
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "q"],
      ["assistant", "完整回答"],
    ]);
  });

  it("retry：用户停止留下的半截回答同样重发", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "q");
    feed({ type: "chunk", delta: "写了一半" });
    await vi.waitFor(() => expect(store.getState().messages[1].content).toBe("写了一半"));
    feed({ type: "error", message: "cancelled", code: "cancelled" });
    await p;
    expect(store.getState().messages[1].incomplete).toBe("stopped");
    const before = streamHandlers.length;
    const pr = store.getState().retry();
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([{ type: "done", full: "新回答" }]);
    await pr;
    expect(store.getState().messages.map((m) => m.content)).toEqual(["q", "新回答"]);
  });

  it("retry：正常完成的回答不会被误丢弃，行为与既往一致（不动作）", async () => {
    const store = await loadConfiguredStore();
    await completeTurn(store, "q", "完整回答");
    const before = streamHandlers.length;
    await store.getState().retry();
    expect(streamHandlers).toHaveLength(before);
    expect(store.getState().messages.map((m) => m.content)).toEqual(["q", "完整回答"]);
  });

  it("会话恢复：incomplete 标记保留，畸形值丢弃", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      {
        id: "db-inc",
        title: "中断会话",
        page_id: null,
        page_title: null,
        updated_at: "9",
        archived: false,
        prompt_tokens: 0,
        completion_tokens: 0,
        messages: JSON.stringify([
          { id: "u1", role: "user", content: "问题" },
          { id: "a1", role: "assistant", content: "写了一半", incomplete: "error" },
          { id: "u2", role: "user", content: "问题二" },
          { id: "a2", role: "assistant", content: "中断", incomplete: "随便什么" },
        ]),
      },
    ]);
    await store.getState().loadSessions();
    const msgs = store.getState().messages;
    expect(msgs[1].incomplete).toBe("error");
    expect(msgs[3].incomplete).toBeUndefined();
  });
});

describe("ai store：上下文预算与截断提示", () => {
  it("历史超出 token 预算：丢弃最早的整轮，并随请求下发截断说明", async () => {
    const store = await loadConfiguredStore();
    const x12000 = "x".repeat(12000); // ≈3000 token，一条就把预算吃满
    store.setState({
      messages: [
        { id: "h1", role: "user", content: x12000 },
        { id: "h2", role: "assistant", content: x12000 },
        { id: "h3", role: "user", content: x12000 },
        { id: "h4", role: "assistant", content: x12000 },
        { id: "h5", role: "user", content: "近提问" },
        { id: "h6", role: "assistant", content: "近回答" },
      ],
    });
    const { p, feed } = await startTurn(store, "新问题");
    feed({ type: "done", full: "ok" });
    await p;
    const msgs = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    const note = msgs.filter((m) => m.role === "system" && m.content.includes("受上下文预算限制"));
    expect(note).toHaveLength(1);
    expect(note[0].content).toContain("4 条");
    // 保留的是最新一轮加本轮提问，最早的整轮已进不了请求
    const roles = msgs.filter((m) => m.role !== "system");
    expect(roles.map((m) => m.content)).toEqual(["近提问", "近回答", "新问题"]);
  });

  it("单条消息就超预算：只保留它的尾部，无需截断说明", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "语".repeat(5000));
    feed({ type: "done", full: "ok" });
    await p;
    const msgs = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    const history = msgs.filter((m) => m.role === "user");
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("语".repeat(3000));
    expect(msgs.some((m) => m.content.includes("受上下文预算限制"))).toBe(false);
  });

  it("预算从配置取：ctx_token_budget 覆盖默认的 3000", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_token_budget: 1000 }) });
    const { p, feed } = await startTurn(store, "语".repeat(5000));
    feed({ type: "done", full: "ok" });
    await p;
    const msgs = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    const history = msgs.filter((m) => m.role === "user");
    expect(history).toHaveLength(1);
    // 单条超预算时保留尾部：按配置的 1000 token 而不是默认 3000
    expect(history[0].content).toBe("语".repeat(1000));
  });

  it("条数上限从配置取：ctx_max_messages 限制保留的历史条数", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_max_messages: 2 }) });
    store.setState({
      messages: [
        { id: "h1", role: "user", content: "一问" },
        { id: "h2", role: "assistant", content: "一答" },
        { id: "h3", role: "user", content: "二问" },
        { id: "h4", role: "assistant", content: "二答" },
      ],
    });
    const { p, feed } = await startTurn(store, "三问");
    feed({ type: "done", full: "ok" });
    await p;
    const msgs = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    const roles = msgs.filter((m) => m.role !== "system");
    // 从最新往回只保留 2 条（二答 + 本轮提问），其余按截断说明上报
    expect(roles.map((m) => m.content)).toEqual(["二答", "三问"]);
    const note = msgs.filter((m) => m.role === "system" && m.content.includes("受上下文预算限制"));
    expect(note[0].content).toContain("3 条");
  });

  it("配置缺省/非法值回落默认预算", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_token_budget: 0, ctx_max_messages: 0 }) });
    const { p, feed } = await startTurn(store, "语".repeat(5000));
    feed({ type: "done", full: "ok" });
    await p;
    const msgs = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    const history = msgs.filter((m) => m.role === "user");
    expect(history[0].content).toBe("语".repeat(3000));
  });

  it("@ 引用长文档且检索不命中：整篇截断并在参考上下文里写明", async () => {
    const store = await loadConfiguredStore();
    M.workspaceState.currentViewId = "v1";
    M.workspaceState.tree = [{ id: "doc1", name: "长文档", children: [] }];
    M.documentGet.mockImplementation(() =>
      Promise.resolve(
        JSON.stringify({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "内".repeat(10000) }] }],
        }),
      ),
    );
    const outgoing = await completeTurn(store, "总结 @长文档 的要点");
    const ref = outgoing.find((m) => m.role === "system" && m.content.startsWith("【用户 @ 引用的文档】"));
    expect(ref).toBeDefined();
    expect(ref!.content).toContain("未命中相关片段");
  });
});

describe("ai store：快捷动作与继续生成", () => {
  it("「总结当前页」取整页纯文本，按 max_chars 截断后作为提问发出", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ max_chars: 6 }) });
    M.getAiEditor.mockImplementation(() => ({ ...M.bridge, getPageText: () => "一二三四五六七八九十" }));
    const p = store.getState().quickAction("summarize");
    await vi.waitFor(() => expect(M.aiChat).toHaveBeenCalledTimes(1));
    const outgoing = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    expect(outgoing[outgoing.length - 1].content).toBe('ai.prompt.summarize:{"content":"一二三四五六"}');
    pump([{ type: "done", full: "摘要" }]);
    await p;
    expect(store.getState().messages[1].content).toBe("摘要");
  });

  it("「续写」不需要选中文本，但没有编辑器桥时提示没有页面且一个请求都不发", async () => {
    const store = await loadConfiguredStore({ bridgeNull: true });
    await store.getState().quickAction("continue");
    expect(M.toastError).toHaveBeenCalledWith("ai.noPage");
    expect(M.aiChat).not.toHaveBeenCalled();
  });

  it("自定义快捷指令：模板里的 {content} 换成选中的文本", async () => {
    const store = await loadConfiguredStore();
    M.getAiEditor.mockImplementation(() => ({ ...M.bridge, getSelectionText: () => "选中的话" }));
    const p = store
      .getState()
      .runQuickAction({ id: "q1", name: "缩写", prompt: "请缩写：{content}", scope: "selection" });
    await vi.waitFor(() => expect(M.aiChat).toHaveBeenCalledTimes(1));
    const outgoing = M.aiChat.mock.calls[0][0] as AiChatMessage[];
    expect(outgoing[outgoing.length - 1].content).toBe("请缩写：选中的话");
    pump([{ type: "done", full: "缩写结果" }]);
    await p;
  });

  it("继续生成：空列表与最后一条是提问时都不发请求，最后一条是回答才追加", async () => {
    const store = await loadConfiguredStore();
    await store.getState().continueGenerate();
    expect(M.aiChat).not.toHaveBeenCalled();
    M.workspaceState.currentViewId = "p1";
    await completeTurn(store, "第一问", "答到一半");
    const lastUser = store.getState().messages[store.getState().messages.length - 1];
    expect(lastUser.role).toBe("assistant");

    const before = streamHandlers.length;
    const p = store.getState().continueGenerate();
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    const outgoing = M.aiChat.mock.calls[1][0] as AiChatMessage[];
    expect(outgoing[outgoing.length - 1].content).toBe("ai.continueGeneratePrompt");
    pump([{ type: "done", full: "接着写完" }]);
    await p;
    expect(store.getState().messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
