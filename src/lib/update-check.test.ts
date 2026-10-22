import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkFeed = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() =>
  vi.fn<(title: string, opts: { duration: number; action: { label: string; onClick: () => void } }) => void>(),
);
const setRoute = vi.fn();
const warn = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkFeed }));
vi.mock("sonner", () => ({ toast: { info, error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => `${key}:${JSON.stringify(vars ?? {})}`,
}));
vi.mock("./logger", () => ({ logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } }));

let store: Map<string, string>;

function stubEnv() {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    clearInterval: (id: number) => clearInterval(id),
  });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn() });
}

async function freshModule() {
  vi.resetModules();
  // 提示条的「去设置」按钮走 lib/app-context 的写侧注册表；resetModules 之后要在新的那份上重绑
  const { bindAppActions } = await import("./app-context");
  bindAppActions({ setRoute });
  return await import("./update-check");
}

beforeEach(() => {
  store = new Map();
  checkFeed.mockReset();
  info.mockReset();
  setRoute.mockReset();
  warn.mockReset();
  stubEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("autoCheckOnce", () => {
  it("开关关着时完全不联网（默认态）", async () => {
    const { autoCheckOnce } = await freshModule();
    expect(await autoCheckOnce()).toBe("disabled");
    expect(checkFeed).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("已是最新版本：不出声", async () => {
    store.set("tsflowy:update-check", "1");
    checkFeed.mockResolvedValue(null);
    const { autoCheckOnce } = await freshModule();
    expect(await autoCheckOnce()).toBe("latest");
    expect(info).not.toHaveBeenCalled();
  });

  it("发现新版本：提示一次并记下版本号，提示条上的动作跳设置页", async () => {
    store.set("tsflowy:update-check", "1");
    checkFeed.mockResolvedValue({ version: "0.9.0" });
    const { autoCheckOnce } = await freshModule();
    expect(await autoCheckOnce()).toBe("notified");
    expect(store.get("tsflowy:update-notified-version")).toBe("0.9.0");
    const action = info.mock.calls[0][1].action;
    expect(info.mock.calls[0][0]).toContain("0.9.0");
    action.onClick();
    expect(setRoute).toHaveBeenCalledWith("settings");
  });

  it("同一个版本不再提醒第二次；版本号变了才再提", async () => {
    store.set("tsflowy:update-check", "1");
    store.set("tsflowy:update-notified-version", "0.9.0");
    checkFeed.mockResolvedValue({ version: "0.9.0" });
    const first = await freshModule();
    expect(await first.autoCheckOnce()).toBe("already-notified");
    expect(info).not.toHaveBeenCalled();

    checkFeed.mockResolvedValue({ version: "0.9.1" });
    expect(await first.autoCheckOnce()).toBe("notified");
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("离线或更新源不可达：静默记日志，不弹错误打扰用户", async () => {
    store.set("tsflowy:update-check", "1");
    checkFeed.mockRejectedValue(new Error("offline"));
    const { autoCheckOnce } = await freshModule();
    expect(await autoCheckOnce()).toBe("failed");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("开关", () => {
  it("打开后排程，关掉时撤掉定时器并清掉「已提醒」记录", async () => {
    const mod = await freshModule();
    expect(mod.autoUpdateCheckEnabled()).toBe(false);

    mod.setAutoUpdateCheckEnabled(true);
    expect(mod.autoUpdateCheckEnabled()).toBe(true);
    expect(store.get("tsflowy:update-check")).toBe("1");

    store.set("tsflowy:update-notified-version", "0.9.0");
    mod.setAutoUpdateCheckEnabled(false);
    expect(store.has("tsflowy:update-check")).toBe(false);
    expect(store.has("tsflowy:update-notified-version")).toBe(false);
  });

  it("关着时 startUpdateChecks 不建任何定时器", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const mod = await freshModule();
    mod.startUpdateChecks();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });
});
