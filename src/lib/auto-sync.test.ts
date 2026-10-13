import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoker = vi.hoisted(() => vi.fn());
const flushAll = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invoker }));
vi.mock("./close-flush", () => ({ flushAllForClose: flushAll }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

// node 测试环境没有 window：给 armTimer/clearTimer 提供最小替身，
// setTimeout 走委托调用，确保拿到 vi.useFakeTimers 打过补丁的全局定时器
function stubWindow() {
  vi.stubGlobal("window", {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    location: { reload: vi.fn() },
  });
}

// 每次取全新模块实例：started / cfg / timer 都是模块级状态
async function freshAutoSync() {
  vi.resetModules();
  return await import("./auto-sync");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stubWindow();
  invoker.mockResolvedValue({ action: "idle", pulled: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("auto-sync 写命令防抖", () => {
  it("view_touch_visited 不触发自动同步：仅浏览页面不该引发同步/上传", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig({ pullOnStart: false, syncAfterWrite: true, delaySecs: 5 });

    m.markLocalWrite("view_touch_visited");
    m.markLocalWrite("view_get"); // 读命令同样不在列
    await vi.advanceTimersByTimeAsync(60_000);

    expect(invoker).not.toHaveBeenCalled();
  });

  it("登记过的写命令在静置满 delaySecs 后触发 run_sync", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig({ pullOnStart: false, syncAfterWrite: true, delaySecs: 5 });

    m.markLocalWrite("doc_save");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(invoker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(invoker).toHaveBeenCalledTimes(1);
    expect(invoker).toHaveBeenCalledWith("run_sync");
    // 与手动同步链路一致：先冲刷挂起写入再同步
    expect(flushAll).toHaveBeenCalled();
  });

  it("同步进行中发生的写入：本轮结束后重新计时，不丢变更", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig({ pullOnStart: false, syncAfterWrite: true, delaySecs: 5 });

    let resolveRun!: (v: unknown) => void;
    invoker.mockImplementationOnce(() => new Promise((r) => (resolveRun = r)));

    m.markLocalWrite("view_rename");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invoker).toHaveBeenCalledTimes(1);

    // 同步尚未结束时的写入不能立刻再发起一轮，也不能被忽略
    m.markLocalWrite("doc_save");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoker).toHaveBeenCalledTimes(1);

    resolveRun({ action: "idle", pulled: false });
    await vi.advanceTimersByTimeAsync(0); // doSync 收尾的微任务
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invoker).toHaveBeenCalledTimes(2);
  });
});
