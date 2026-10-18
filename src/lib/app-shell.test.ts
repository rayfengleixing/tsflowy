import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoker = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invoker }));
// @/lib/invoke 会连带引入 auto-sync → sonner，node 环境下 sonner 需要真实 DOM
vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("./logger", () => ({ logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } }));

async function freshShell() {
  vi.resetModules();
  return await import("./app-shell");
}

beforeEach(() => {
  invoker.mockReset();
  warn.mockReset();
  // node 测试环境没有 localStorage：偏好类用例需要一个能读写的替身
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncNativeLang", () => {
  it("把当前语言原样报给原生壳层", async () => {
    invoker.mockResolvedValue(undefined);
    const { syncNativeLang } = await freshShell();
    syncNativeLang("en-US");
    expect(invoker).toHaveBeenCalledWith("set_lang", { lang: "en-US" });
  });

  it("菜单重建失败只记日志，不打断界面切语言", async () => {
    invoker.mockRejectedValue(new Error("refresh native menu failed"));
    const { syncNativeLang } = await freshShell();
    expect(() => syncNativeLang("zh-CN")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
  });
});

describe("开机自启", () => {
  it("开关落到 set_autostart 的 enabled 入参上", async () => {
    invoker.mockResolvedValue(undefined);
    const { setAutostart } = await freshShell();
    await setAutostart(true);
    expect(invoker).toHaveBeenCalledWith("set_autostart", { enabled: true });
  });

  it("注册表状态原样透出，供设置页回显启动命令", async () => {
    invoker.mockResolvedValue({ enabled: true, command: '"D:\\TsFlowy.exe"', unavailable: false });
    const { getAutostartState } = await freshShell();
    await expect(getAutostartState()).resolves.toEqual({
      enabled: true,
      command: '"D:\\TsFlowy.exe"',
      unavailable: false,
    });
  });
});

describe("崩溃自动重启", () => {
  it("偏好只在显式打开时为真，关掉后回到默认", async () => {
    const { crashRestartEnabled, setCrashRestartEnabled } = await freshShell();
    expect(crashRestartEnabled()).toBe(false);
    setCrashRestartEnabled(true);
    expect(crashRestartEnabled()).toBe(true);
    setCrashRestartEnabled(false);
    expect(crashRestartEnabled()).toBe(false);
  });

  it("localStorage 不可用时不抛，保持关闭", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    const { crashRestartEnabled, setCrashRestartEnabled } = await freshShell();
    expect(() => setCrashRestartEnabled(true)).not.toThrow();
    expect(crashRestartEnabled()).toBe(false);
  });

  it("IPC 问不到轮次时按「不是重启拉起的」处理", async () => {
    invoker.mockRejectedValue(new Error("no such command"));
    const { crashRestartRound } = await freshShell();
    await expect(crashRestartRound()).resolves.toBe(0);
  });
});
