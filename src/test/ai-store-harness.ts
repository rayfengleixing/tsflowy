import { beforeEach, expect, type Mock, vi } from "vitest";
import type { AiConfig, AiChatEvent, AiChatMessage } from "@/lib/ai";
import type { StoredSession } from "@/stores/ai";

// AI store 用例的共享骨架：原本长在 `stores/ai.test.ts` 顶部（第 82–224 行），拆成多个主题
// 用例文件后由它们共用。**桩包 `M` 不在这里造**——`vi.mock` 与 `vi.hoisted` 由 vitest 提升到
// 各测试文件自己的 import 之前，跨文件复用会踩空，所以每个用例文件各留一份 mock 表，
// 造好后用 `bindAiMocks(M)` 交回这里（形制对齐 `lib/app-context.ts` 的 `bindAppReaders`）。
interface AiStoreMocks {
  aiChat: Mock;
  aiGetConfig: Mock;
  aiSessionList: Mock;
  aiSessionSave: Mock;
  aiSessionDelete: Mock;
  aiUsageSummary: Mock;
  docSearchSnippets: Mock;
  getAiEditor: Mock;
  applyEdit: Mock;
  documentGet: Mock;
  documentSave: Mock;
  runRetrievalCall: Mock;
  runWriteAction: Mock;
  runUndoPlan: Mock;
  resolvePage: Mock;
  applyEditToDocJson: Mock;
  newId: Mock;
  workspaceState: { currentViewId: string | null; tree: unknown[] };
  bridge: Record<string, unknown>;
}

let M: AiStoreMocks;

/** 各用例文件把自己那份 `vi.hoisted` 桩包交进来；helper 只在测试运行期读它，绑定发生在用例之前 */
export function bindAiMocks(mocks: AiStoreMocks) {
  M = mocks;
}

let idTick = 0;
export let streamHandlers: ((ev: AiChatEvent) => void)[] = [];
export const storage = new Map<string, string>();

export function defaultConfig(overrides: Partial<AiConfig> = {}): AiConfig {
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

export type Store = Awaited<ReturnType<typeof loadStore>>;

/** 重新加载 store 模块（每个测试一份干净状态），并把 aiChat 桩成可手动投喂事件的形式 */
export async function loadStore(opts: LoadOptions = {}) {
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
export function pump(evs: AiChatEvent[]) {
  const handler = streamHandlers[streamHandlers.length - 1];
  let full = "";
  for (const ev of evs) {
    if (ev.type === "chunk") full += ev.delta;
    handler(ev.type === "done" && !ev.full ? { ...ev, full } : ev);
  }
}

/** 走完整的一轮问答，返回该轮发给服务端的消息数组 */
export async function completeTurn(store: Store, text: string, reply = "回答") {
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
export async function loadConfiguredStore(opts: LoadOptions = {}): Promise<Store> {
  const store = await loadStore(opts);
  await store.getState().loadConfig();
  return store;
}

/** 起一轮提问并等 handler 就绪，返回手动投喂用的入口 */
export async function startTurn(store: Store, text: string) {
  const p = store.getState().send(text);
  await vi.waitFor(() => expect(streamHandlers.length).toBe(1));
  return { p, feed: streamHandlers[0] };
}

export const EDIT_FULL =
  '回答\n\n```tsflowy-edit\n{"op":"append_to_document","summary":"补一段","content":"新内容"}\n```';

export function session(i: number): StoredSession {
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
