import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoker = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invoker }));
// @/lib/invoke 会连带引入 auto-sync → sonner，node 环境下 sonner 需要真实 DOM
vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

// node 测试环境没有 window/document/localStorage：只补本模块用到的那几样
let store: Map<string, string>;
let winListeners: Map<string, () => void>;

beforeEach(() => {
  store = new Map();
  winListeners = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("window", {
    setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
    addEventListener: (ev: string, cb: () => void) => winListeners.set(ev, cb),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (ev: string, cb: () => void) => winListeners.set(ev, cb),
  });
  invoker.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 模块级 lastFlushed 是状态，每个用例要全新实例
async function freshMirror() {
  vi.resetModules();
  return await import("./prefs-mirror");
}

describe("hydratePrefs（备份里的偏好回填本机）", () => {
  it("本机缺失的键从镜像写回，已有的键不被覆盖", async () => {
    store.set("tsflowy-shortcuts", JSON.stringify({ "mod+b": "local" }));
    invoker.mockImplementation((cmd: string) =>
      cmd === "get_prefs"
        ? Promise.resolve({
            "tsflowy-shortcuts": JSON.stringify({ "mod+b": "from-backup" }),
            "tsflowy:auto-sync": '{"pullOnStart":true}',
          })
        : Promise.resolve(undefined),
    );
    const { hydratePrefs } = await freshMirror();
    await hydratePrefs();

    expect(JSON.parse(store.get("tsflowy-shortcuts") ?? "")).toEqual({ "mod+b": "local" });
    expect(store.get("tsflowy:auto-sync")).toBe('{"pullOnStart":true}');
  });

  it("镜像里的非白名单键与非法值不进 localStorage", async () => {
    invoker.mockResolvedValue({ "tsflowy-ai-sessions-v1": "huge", "tsflowy-lang": 42 });
    const { hydratePrefs } = await freshMirror();
    await hydratePrefs();

    expect(store.has("tsflowy-ai-sessions-v1")).toBe(false);
    expect(store.has("tsflowy-lang")).toBe(false);
  });

  it("读取镜像失败时照常完成启动，不抛给调用方", async () => {
    invoker.mockRejectedValue(new Error("ipc unavailable"));
    const { hydratePrefs } = await freshMirror();

    await expect(hydratePrefs()).resolves.toBeUndefined();
  });

  it("写入只发生在值变化之后", async () => {
    vi.useFakeTimers();
    invoker.mockResolvedValue({});
    const { hydratePrefs } = await freshMirror();
    await hydratePrefs();
    invoker.mockClear();

    store.set("tsflowy-theme", "dark");
    await vi.advanceTimersByTimeAsync(30_000);
    const written = invoker.mock.calls.find((c) => c[0] === "set_prefs")?.[1] as {
      prefs: Record<string, string>;
    };
    expect(written.prefs["tsflowy-theme"]).toBe("dark");

    invoker.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invoker.mock.calls.filter((c) => c[0] === "set_prefs")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("页面隐藏时立即冲刷，不等下一个周期", async () => {
    store.set("tsflowy-lang", "en-US");
    invoker.mockResolvedValue({});
    const { hydratePrefs } = await freshMirror();
    await hydratePrefs();
    invoker.mockClear();

    store.set("tsflowy-accent", "violet");
    winListeners.get("pagehide")?.();
    await Promise.resolve();

    const written = invoker.mock.calls.find((c) => c[0] === "set_prefs")?.[1] as {
      prefs: Record<string, string>;
    };
    expect(written.prefs["tsflowy-accent"]).toBe("violet");
  });
});
