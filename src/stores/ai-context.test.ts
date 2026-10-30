// AI store 单测（按主题拆自 `ai.test.ts`）：上下文取数与输入形态：范围开关、图片输入、token 用量与计价、档位切换重载配置。
// 桩包必须每个测试文件各造一份：`vi.mock` 与 `vi.hoisted` 由 vitest 提到本文件的 import 之前，跨文件复用会踩空，
// 所以只有 mock 表各留一份，其余骨架（helper、根级 beforeEach、localStorage 替身）共用 `test/ai-store-harness.ts`。
import { describe, expect, it, vi } from "vitest";
import type { AiChatMessage } from "@/lib/ai";
import {
  bindAiMocks,
  completeTurn,
  defaultConfig,
  loadConfiguredStore,
  loadStore,
  pump,
  type Store,
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
