import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig, AiChatEvent, AiChatMessage } from "@/lib/ai";
import type { StoredSession } from "@/stores/ai";

// AI store 单测：IPC / 编辑器桥 / 工作区全部打桩，只验证 store 自身的编排逻辑
// （落库时机、token 预算截断、停止后编辑竞态、会话归档/裁剪）。

const M = vi.hoisted(() => ({
  aiChat: vi.fn((_msgs: unknown, _onEvent: unknown) => Promise.resolve()),
  aiCancel: vi.fn(() => Promise.resolve()),
  aiGetConfig: vi.fn((): Promise<unknown> => Promise.resolve({})),
  aiSaveConfig: vi.fn(() => Promise.resolve()),
  aiSessionList: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  aiSessionSave: vi.fn((_row: unknown) => Promise.resolve()),
  aiSessionDelete: vi.fn((_id: string) => Promise.resolve()),
  docSearchSnippets: vi.fn(() => Promise.resolve([] as string[])),
  getAiEditor: vi.fn((): unknown => null),
  applyEdit: vi.fn((_op: string, _content: string) => ({ applied: true, revert: {} })),
  undoAiEdit: vi.fn((_revert: unknown) => true),
  documentGet: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  newId: vi.fn(() => "id-1"),
  workspaceState: { currentViewId: null as string | null, tree: [] as unknown[] },
  bridge: {
    getPageTitle: () => "标题",
    getSelectionText: () => "选中",
    getPageText: () => "整页文本",
    getEditTargetText: (_op: string) => "原文",
    applyEdit: (op: string, content: string) => M.applyEdit(op, content),
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
  docSearchSnippets: M.docSearchSnippets,
  aiErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/ai-editor", () => ({ getAiEditor: M.getAiEditor }));
vi.mock("@/lib/db", () => ({ newId: M.newId }));
vi.mock("@/lib/documents", () => ({ documentApi: { get: M.documentGet } }));
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
    base_url: "https://api.example.com/v1",
    model: "some-model",
    max_chars: 8000,
    confirm_edit: true,
    temperature: 0.7,
    max_tokens: 0,
    system_prompt: "",
    profiles: [],
    active_profile: "",
    quick_actions: [],
    use_tools: false,
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
  M.aiSessionSave.mockImplementation(() => Promise.resolve());
  M.aiSessionDelete.mockImplementation(() => Promise.resolve());
  M.documentGet.mockImplementation(() => Promise.resolve(null));
  M.docSearchSnippets.mockImplementation(() => Promise.resolve([] as string[]));
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
    expect(msg.edit?.state).toBe("pending");
    expect(M.applyEdit).not.toHaveBeenCalled();
  });

  it("confirm_edit 关闭时 done 带编辑指令：直接落地为 applied", async () => {
    const store = await loadConfiguredStore({ config: defaultConfig({ confirm_edit: false }) });
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "done", full: EDIT_FULL });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.edit?.state).toBe("applied");
    expect(M.applyEdit).toHaveBeenCalledWith("append_to_document", "新内容");
    expect(msg.content).toBe("回答");
  });

  it("没有打开文档时编辑指令标记为 unavailable", async () => {
    const store = await loadConfiguredStore({ bridgeNull: true });
    const { p, feed } = await startTurn(store, "改一下");
    feed({ type: "done", full: EDIT_FULL });
    await p;
    expect(store.getState().messages[1].edit?.state).toBe("unavailable");
  });

  it("编辑指令块格式不对：正文剥掉坏块，卡片标记 malformed", async () => {
    const store = await loadConfiguredStore();
    const { p, feed } = await startTurn(store, "q");
    feed({ type: "done", full: "回答\n\n```tsflowy-edit\n{坏 json}\n```" });
    await p;
    const msg = store.getState().messages[1];
    expect(msg.content).toBe("回答");
    expect(msg.edit?.state).toBe("malformed");
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

  it("newChat：归档当前会话，超出 20 条上限时删除被挤出的最老会话", async () => {
    const store = await loadConfiguredStore();
    const sessions = Array.from({ length: 20 }, (_, i) => session(20 - i)); // s20 最新 … s1 最老
    const oldActive = store.getState().activeSessionId;
    store.setState({ messages: [{ id: "u1", role: "user", content: "你好" }], sessions });
    store.getState().newChat();
    const s = store.getState();
    expect(s.messages).toEqual([]);
    expect(s.sessions).toHaveLength(20);
    expect(s.sessions[0].title).toBe("你好");
    expect(s.sessions.some((x) => x.id === "s1")).toBe(false);
    expect(M.aiSessionSave).toHaveBeenCalledTimes(1);
    expect(M.aiSessionSave.mock.calls[0][0]).toMatchObject({ id: oldActive });
    expect(M.aiSessionDelete).toHaveBeenCalledWith("s1");
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
});
