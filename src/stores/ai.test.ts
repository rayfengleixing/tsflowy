import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig, AiChatEvent, AiChatMessage } from "@/lib/ai";
import type { StoredSession } from "@/stores/ai";

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

let idTick = 0;
let streamHandlers: ((ev: AiChatEvent) => void)[] = [];
const storage = new Map<string, string>();

function defaultConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    enabled: true,
    provider: "custom",
    protocol: "",
    base_url: "https://api.example.com/v1",
    model: "some-model",
    max_chars: 8000,
    confirm_edit: true,
    temperature: 0.7,
    thinking: "auto",
    ctx_token_budget: 3000,
    ctx_max_messages: 40,
    ctx_scope: "full",
    max_tokens: 0,
    system_prompt: "",
    profiles: [],
    active_profile: "",
    quick_actions: [],
    use_tools: false,
    price_input: 0,
    price_output: 0,
    agent_rounds: 4,
    first_byte_timeout: 30,
    idle_timeout: 120,
    stream_retries: 2,
    has_api_key: true,
    api_key_masked: "sk-***",
    ...overrides,
  };
}

interface LoadOptions {
  config?: AiConfig;
  bridgeNull?: boolean;
  chatThrows?: boolean;
}

type Store = Awaited<ReturnType<typeof loadStore>>;

/** 重新加载 store 模块（每个测试一份干净状态），并把 aiChat 桩成可手动投喂事件的形式 */
async function loadStore(opts: LoadOptions = {}) {
  vi.resetModules();
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  M.newId.mockImplementation(() => `id-${++idTick}`);
  // clearAllMocks 只清调用记录、不清 mockImplementation，被测试改写过的桩要恢复默认
  M.aiSessionList.mockImplementation(() => Promise.resolve([]));
  M.aiSessionSave.mockImplementation(() => Promise.resolve());
  M.aiSessionDelete.mockImplementation(() => Promise.resolve());
  M.aiUsageSummary.mockImplementation(() => Promise.resolve({ sessions: 0, prompt_tokens: 0, completion_tokens: 0 }));
  M.documentGet.mockImplementation(() => Promise.resolve(null));
  M.documentSave.mockImplementation(() => Promise.resolve());
  M.docSearchSnippets.mockImplementation(() => Promise.resolve([] as string[]));
  M.runRetrievalCall.mockImplementation(() => Promise.resolve("检索桩结果"));
  M.runWriteAction.mockImplementation(() => Promise.resolve({ ok: true, detail: "已执行" }));
  M.runUndoPlan.mockImplementation(() => Promise.resolve({ ok: true, detail: "已撤销" }));
  M.resolvePage.mockImplementation(() => null);
  M.applyEditToDocJson.mockImplementation(() => ({ ok: false, reason: "bad_structure" }));
  streamHandlers = [];
  M.getAiEditor.mockImplementation(() => (opts.bridgeNull ? null : M.bridge));
  M.applyEdit.mockImplementation(() => ({ applied: true, revert: {} }));
  // aiChat 桩：注册事件回调后挂起，直到收到 done/error 才 resolve（复现真实流式的生命周期）
  let settle: (() => void) | null = null;
  M.aiChat.mockImplementation(async (_msgs: unknown, onEvent: unknown) => {
    const cb = onEvent as (ev: AiChatEvent) => void;
    streamHandlers.push((ev) => {
      cb(ev);
      if (ev.type === "done" || ev.type === "error") {
        settle?.();
        settle = null;
      }
    });
    if (opts.chatThrows) throw new Error("boom");
    await new Promise<void>((r) => (settle = r));
  });
  M.aiGetConfig.mockResolvedValue(opts.config ?? defaultConfig());
  const mod = await import("@/stores/ai");
  return mod.useAiStore;
}

/** 向最近一轮投喂事件直到 done（done.full 缺省用累积的 chunk 全文） */
function pump(evs: AiChatEvent[]) {
  const handler = streamHandlers[streamHandlers.length - 1];
  let full = "";
  for (const ev of evs) {
    if (ev.type === "chunk") full += ev.delta;
    handler(ev.type === "done" && !ev.full ? { ...ev, full } : ev);
  }
}

/** 走完整的一轮问答，返回该轮发给服务端的消息数组 */
async function completeTurn(store: Store, text: string, reply = "回答") {
  const before = streamHandlers.length;
  const p = store.getState().send(text);
  await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
  pump([
    { type: "chunk", delta: reply },
    { type: "done", full: reply },
  ]);
  await p;
  return M.aiChat.mock.calls[M.aiChat.mock.calls.length - 1][0] as AiChatMessage[];
}

/** 开启「改前确认」并加载配置 */
async function loadConfiguredStore(opts: LoadOptions = {}): Promise<Store> {
  const store = await loadStore(opts);
  await store.getState().loadConfig();
  return store;
}

/** 起一轮提问并等 handler 就绪，返回手动投喂用的入口 */
async function startTurn(store: Store, text: string) {
  const p = store.getState().send(text);
  await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
  return { p, feed: streamHandlers[0] };
}

const EDIT_FULL = '回答\n\n```tsflowy-edit\n{"op":"append_to_document","summary":"补一段","content":"新内容"}\n```';

function session(i: number): StoredSession {
  return {
    id: `s${i}`,
    title: `会话${i}`,
    updatedAt: i,
    messages: [{ id: `m${i}`, role: "user", content: `问题${i}` }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  M.workspaceState.currentViewId = null;
  M.workspaceState.tree = [];
});

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

describe("ai store：上下文范围开关", () => {
  const callBlock = (json: string) => `\`\`\`tsflowy-call\n${json}\n\`\`\``;
  const docWithText = (text: string) =>
    JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

  it("关闭上下文：协议照发，当前文档一个字都不带", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_scope: "off" }) });
    const msgs = await completeTurn(store, "总结一下");
    const sys = msgs[0].content;
    expect(sys).toContain("TsFlowy"); // 动作协议仍在（建页 / 改表 / 检索都要用）
    expect(sys).not.toContain("整页文本"); // 编辑器桥里的正文没进来
    expect(sys).toContain("用户已关闭当前文档上下文");
  });

  it("仅本页：带当前页全文，但不下发工具、也不读 @ 引用的文档", async () => {
    M.workspaceState.tree = [{ id: "v-report", name: "周报", layout: "document", children: [] }];
    M.documentGet.mockImplementation(() => Promise.resolve(docWithText("正文A")));
    const store = await loadConfiguredStore({
      config: defaultConfig({ use_tools: true, ctx_scope: "page_only" }),
    });
    const msgs = await completeTurn(store, "@周报 里有什么");
    expect(msgs[0].content).toContain("整页文本");
    expect(msgs[0].content).toContain("【上下文范围】本次只以【当前文档】为上下文");
    expect(msgs.some((m) => m.content.includes("正文A"))).toBe(false);
    expect(M.documentGet).not.toHaveBeenCalled();
    // 第三参是工具定义：仅本页档不下发，模型没有检索可用
    expect(M.aiChat.mock.calls[0][2]).toBeUndefined();
  });

  it("全部范围且开了 function calling 时工具照常下发（对照「仅本页」不下发）", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ use_tools: true }) });
    await completeTurn(store, "q");
    expect(M.aiChat.mock.calls[0][2]).toEqual([]);
  });

  it("仅本页时模型照旧发检索块：不执行、把原因回灌再要一轮，正文后说明", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_scope: "page_only" }) });
    const p = store.getState().send("查点别的");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
    streamHandlers[0]({ type: "done", full: `我先查。\n\n${callBlock('{"tool":"list_pages","args":{}}')}` });
    await vi.waitFor(() => expect(streamHandlers.length).toBe(2));
    expect(M.runRetrievalCall).not.toHaveBeenCalled();
    const second = M.aiChat.mock.calls[1][0] as AiChatMessage[];
    expect(second[second.length - 1]?.content).toContain("仅本页");
    streamHandlers[1]({ type: "done", full: "只根据这一页作答" });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.content).toContain("只根据这一页作答");
    expect(msg.content).toContain("ai.searchScopeBlocked");
  });

  it("没有可编辑文档时「仅本页」按全部处理（此时关掉检索就什么都没有了）", async () => {
    const store = await loadConfiguredStore({
      config: defaultConfig({ use_tools: true, ctx_scope: "page_only" }),
      bridgeNull: true,
    });
    const msgs = await completeTurn(store, "q");
    expect(msgs[0].content).toContain("没有打开中的可编辑文档");
    expect(M.aiChat.mock.calls[0][2]).toEqual([]);
  });

  it("setCtxScope 只改范围：其余字段原样回传（覆盖式保存，漏一个字段就等于把它重置）", async () => {
    const store = await loadConfiguredStore({
      config: defaultConfig({ thinking: "off", ctx_token_budget: 5000, use_tools: true }),
    });
    await store.getState().setCtxScope("page_only");
    const input = M.aiSaveConfig.mock.calls[0][0];
    expect(input.ctxScope).toBe("page_only");
    expect(input.thinking).toBe("off");
    expect(input.ctxTokenBudget).toBe(5000);
    expect(input.useTools).toBe(true);
    expect(input.apiKey).toBeNull();
  });

  it("范围没变时不写盘", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ ctx_scope: "off" }) });
    await store.getState().setCtxScope("off");
    expect(M.aiSaveConfig).not.toHaveBeenCalled();
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

describe("ai store：图片附件", () => {
  const IMG = { name: "截图.png", path: "assets/1.png" };

  /** 走完整一轮（可只带图不带文字），返回该轮发给服务端的消息数组 */
  async function completeImageTurn(store: Store, text: string, images?: (typeof IMG)[]) {
    const before = streamHandlers.length;
    const p = store.getState().send(text, images);
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([
      { type: "chunk", delta: "回答" },
      { type: "done", full: "回答" },
    ]);
    await p;
    return M.aiChat.mock.calls[M.aiChat.mock.calls.length - 1][0] as AiChatMessage[];
  }

  it("请求里只带 assets 路径，base64 由 Rust 侧内联", async () => {
    const store = await loadConfiguredStore();
    const outgoing = await completeImageTurn(store, "这张图讲什么", [IMG]);
    expect(outgoing[outgoing.length - 1]).toEqual({
      role: "user",
      content: "这张图讲什么",
      images: [{ path: "assets/1.png" }],
    });
    // 会话消息里保留名字，气泡才能显示alt与缩略图
    expect(store.getState().messages[0].images).toEqual([IMG]);
  });

  it("只附图不打字也算一次提问", async () => {
    const store = await loadConfiguredStore();
    const outgoing = await completeImageTurn(store, "", [IMG]);
    expect(outgoing[outgoing.length - 1].content).toBe("");
    expect(outgoing[outgoing.length - 1].images).toEqual([{ path: "assets/1.png" }]);
    expect(store.getState().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("空正文且没有附件时不发消息", async () => {
    const store = await loadConfiguredStore();
    await store.getState().send("   ", []);
    expect(M.aiChat).not.toHaveBeenCalled();
    expect(store.getState().messages).toEqual([]);
  });

  it("改后重发：没重新附图就沿用原提问的附件", async () => {
    const store = await loadConfiguredStore();
    await completeImageTurn(store, "第一问", [IMG]);
    const userId = store.getState().messages[0].id;
    const before = streamHandlers.length;
    const p = store.getState().resend(userId, "改过的问法");
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([
      { type: "chunk", delta: "再答" },
      { type: "done", full: "再答" },
    ]);
    await p;
    const outgoing = M.aiChat.mock.calls[M.aiChat.mock.calls.length - 1][0] as AiChatMessage[];
    expect(outgoing[outgoing.length - 1]).toEqual({
      role: "user",
      content: "改过的问法",
      images: [{ path: "assets/1.png" }],
    });
  });

  it("重新生成沿用原提问的附件", async () => {
    const store = await loadConfiguredStore();
    await completeImageTurn(store, "看图", [IMG]);
    const assistantId = store.getState().messages[1].id;
    const before = streamHandlers.length;
    const p = store.getState().regenerate(assistantId);
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([
      { type: "chunk", delta: "重答" },
      { type: "done", full: "重答" },
    ]);
    await p;
    const outgoing = M.aiChat.mock.calls[M.aiChat.mock.calls.length - 1][0] as AiChatMessage[];
    expect(outgoing[outgoing.length - 1].images).toEqual([{ path: "assets/1.png" }]);
  });

  it("会话恢复：图片附件保留，非 assets 路径与畸形项丢弃", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      {
        id: "db-img",
        title: "带图会话",
        page_id: null,
        page_title: null,
        updated_at: "9",
        messages: JSON.stringify([
          {
            id: "u1",
            role: "user",
            content: "看图",
            images: [
              { name: "a.png", path: "assets/a.png" },
              { name: "越权", path: "C:/Windows/notepad.exe" },
              { path: 42 },
              "不是对象",
            ],
          },
        ]),
      },
    ]);
    await store.getState().loadSessions();
    expect(store.getState().messages[0].images).toEqual([{ name: "a.png", path: "assets/a.png" }]);
  });

  it("恢复的历史会话重新提问时仍会把图片带上", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      {
        id: "db-img2",
        title: "带图会话",
        page_id: null,
        page_title: null,
        updated_at: "9",
        messages: JSON.stringify([
          { id: "u1", role: "user", content: "看图", images: [{ name: "a.png", path: "assets/a.png" }] },
        ]),
      },
    ]);
    await store.getState().loadSessions();
    await store.getState().loadConfig();
    const outgoing = await completeImageTurn(store, "再看一次", [{ name: "b.png", path: "assets/b.png" }]);
    const withImages = outgoing.filter((m) => m.images);
    expect(withImages.map((m) => m.images?.[0].path)).toEqual(["assets/a.png", "assets/b.png"]);
  });
});

describe("ai store：token 用量累计", () => {
  /** 库里的会话行（Rust 侧 AiSessionRow 的形状） */
  function row(id: string, opts: { updatedAt: number; prompt?: number; completion?: number; content?: string }) {
    return {
      id,
      title: `会话${id}`,
      page_id: null,
      page_title: null,
      updated_at: String(opts.updatedAt),
      messages: JSON.stringify([{ id: `m-${id}`, role: "user", content: opts.content ?? `问题${id}` }]),
      prompt_tokens: opts.prompt ?? 0,
      completion_tokens: opts.completion ?? 0,
    };
  }

  /** 走完一轮带 usage 的问答 */
  async function turnWithUsage(store: Store, text: string, prompt: number, completion: number) {
    const before = streamHandlers.length;
    const p = store.getState().send(text);
    await vi.waitFor(() => expect(streamHandlers.length).toBe(before + 1));
    pump([
      { type: "chunk", delta: "回答" },
      {
        type: "done",
        full: "回答",
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      },
    ]);
    await p;
  }

  it("轮次收尾：会话行带上本会话累计的输入/输出 token", async () => {
    const store = await loadConfiguredStore();
    await turnWithUsage(store, "你好", 1200, 300);
    const last = M.aiSessionSave.mock.calls[M.aiSessionSave.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(last).toMatchObject({ prompt_tokens: 1200, completion_tokens: 300 });
    expect(store.getState().usageTotal).toEqual({ prompt: 1200, completion: 300, total: 1500 });
  });

  it("多轮问答在同一会话里累加，不互相覆盖", async () => {
    const store = await loadConfiguredStore();
    await turnWithUsage(store, "第一问", 1000, 200);
    await turnWithUsage(store, "第二问", 500, 100);
    expect(store.getState().usageTotal).toEqual({ prompt: 1500, completion: 300, total: 1800 });
    const last = M.aiSessionSave.mock.calls[M.aiSessionSave.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(last).toMatchObject({ prompt_tokens: 1500, completion_tokens: 300 });
  });

  it("落库后重取跨会话累计", async () => {
    const store = await loadConfiguredStore();
    await turnWithUsage(store, "你好", 1200, 300);
    await vi.waitFor(() => expect(M.aiUsageSummary.mock.calls.length).toBeGreaterThan(0));
  });

  it("首次载入：当前会话的用量从库行读回", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([row("cur", { updatedAt: 9, prompt: 700, completion: 80 })]);
    await store.getState().loadSessions();
    expect(store.getState().usageTotal).toEqual({ prompt: 700, completion: 80, total: 780 });
  });

  it("切回历史会话：接上它自己那份用量继续累加", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([
      row("cur", { updatedAt: 9 }),
      row("old", { updatedAt: 8, prompt: 4000, completion: 900 }),
    ]);
    await store.getState().loadSessions();
    store.getState().switchSession("old");
    expect(store.getState().usageTotal).toEqual({ prompt: 4000, completion: 900, total: 4900 });
  });

  it("开新会话：归档行带着已用量，当前累计清零", async () => {
    const store = await loadConfiguredStore();
    await turnWithUsage(store, "你好", 1200, 300);
    store.getState().newChat();
    const archived = M.aiSessionSave.mock.calls[M.aiSessionSave.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(archived).toMatchObject({ prompt_tokens: 1200, completion_tokens: 300 });
    expect(store.getState().usageTotal).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("删除会话后重取累计：总数里不该还算着被删的那段", async () => {
    const store = await loadStore();
    M.aiSessionList.mockResolvedValue([row("cur", { updatedAt: 9 }), row("old", { updatedAt: 8, prompt: 10 })]);
    await store.getState().loadSessions();
    expect(M.aiUsageSummary).toHaveBeenCalledTimes(1);
    store.getState().deleteSession("old");
    await vi.waitFor(() => expect(M.aiUsageSummary).toHaveBeenCalledTimes(2));
  });

  it("累计拉取失败：静默隐藏用量条，不影响会话载入", async () => {
    M.aiUsageSummary.mockImplementation(() => Promise.reject(new Error("db down")));
    const store = await loadStore();
    await store.getState().loadSessions();
    expect(store.getState().usageSummary).toBeNull();
    expect(store.getState().sessionsLoaded).toBe(true);
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

describe("ai store：档位切换回传整份配置", () => {
  it("switchProfile：只改 activeProfile，thinking/上下文预算与档位（不含明文 Key）原样带回", async () => {
    const profiles = [
      {
        id: "p1",
        name: "强力",
        base_url: "https://b.example/v1",
        model: "m-strong",
        temperature: 0.3,
        protocol: "anthropic",
        has_api_key: true,
        api_key_masked: "sk-****cdef",
      },
    ];
    const store = await loadConfiguredStore({
      config: defaultConfig({
        thinking: "off",
        ctx_token_budget: 5000,
        ctx_max_messages: 12,
        agent_rounds: 7,
        stream_retries: 5,
        profiles,
        active_profile: "p1",
      }),
    });
    await store.getState().switchProfile("p2");
    expect(M.aiSaveConfig).toHaveBeenCalledTimes(1);
    const input = M.aiSaveConfig.mock.calls[0][0];
    expect(input.activeProfile).toBe("p2");
    expect(input.apiKey).toBeNull();
    expect(input.thinking).toBe("off");
    expect(input.ctxTokenBudget).toBe(5000);
    expect(input.ctxMaxMessages).toBe(12);
    expect(input.ctxScope).toBe("full");
    // 网络调优参数同理由整份回写带回：漏一项就等于把它悄悄重置成默认
    expect(input.agentRounds).toBe(7);
    expect(input.streamRetries).toBe(5);
    const saved = input.profiles as Record<string, unknown>[];
    expect(saved[0]).toMatchObject({ id: "p1", model: "m-strong", protocol: "anthropic" });
    // 掩码字段不回传成 Key；缺 api_key 即「Rust 侧按 id 保留原 Key」的语义
    expect(saved[0].api_key).toBeUndefined();
  });
});
