import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoker = vi.hoisted(() => vi.fn());
const flushAll = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invoker }));
vi.mock("./close-flush", () => ({ flushAllForClose: flushAll }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

// node 测试环境没有 window/document：给 armTimer/clearTimer/armInterval 提供最小替身，
// setTimeout/setInterval 走委托调用，确保拿到 vi.useFakeTimers 打过补丁的全局定时器
let docListeners: Map<string, () => void>;
let docStub: { visibilityState: string };
function stubWindow() {
  docListeners = new Map();
  docStub = { visibilityState: "visible" };
  vi.stubGlobal("window", {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    location: { reload: vi.fn() },
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return docStub.visibilityState;
    },
    addEventListener: (ev: string, cb: () => void) => docListeners.set(ev, cb),
    removeEventListener: (ev: string) => docListeners.delete(ev),
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
    m.saveAutoSyncConfig({
      pullOnStart: false,
      syncAfterWrite: true,
      delaySecs: 5,
      periodic: false,
      intervalSecs: 300,
    });

    m.markLocalWrite("view_touch_visited");
    m.markLocalWrite("view_get"); // 读命令同样不在列
    await vi.advanceTimersByTimeAsync(60_000);

    expect(invoker).not.toHaveBeenCalled();
  });

  it("登记过的写命令在静置满 delaySecs 后触发 run_sync", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig({
      pullOnStart: false,
      syncAfterWrite: true,
      delaySecs: 5,
      periodic: false,
      intervalSecs: 300,
    });

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
    m.saveAutoSyncConfig({
      pullOnStart: false,
      syncAfterWrite: true,
      delaySecs: 5,
      periodic: false,
      intervalSecs: 300,
    });

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

describe("auto-sync 周期同步调度", () => {
  const periodicCfg = {
    pullOnStart: false,
    syncAfterWrite: false,
    delaySecs: 60,
    periodic: true,
    intervalSecs: 300,
  };

  it("开启周期同步后每 intervalSecs 自动跑一轮 run_sync", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig(periodicCfg);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(invoker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invoker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it("未开启周期同步：时间怎么走都不自发同步", async () => {
    const m = await freshAutoSync();
    m.startAutoSync(); // localStorage 空 → DEFAULTS（periodic=false）

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("上一轮还没结束时到来的拍直接跳过，不并发两个 run_sync；后续拍照常", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig(periodicCfg);

    let resolveRun!: (v: unknown) => void;
    invoker.mockImplementationOnce(() => new Promise((r) => (resolveRun = r)));

    await vi.advanceTimersByTimeAsync(300_000); // 第 1 拍：run_sync 挂起未返回
    expect(invoker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000); // 第 2 拍：syncing=true，跳过
    expect(invoker).toHaveBeenCalledTimes(1);

    resolveRun({ action: "idle", pulled: false });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000); // 第 3 拍：恢复正常执行
    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it("保存配置关闭周期同步：撤掉定时器；重新开启：重新挂上", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig(periodicCfg);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(invoker).toHaveBeenCalledTimes(1);

    m.saveAutoSyncConfig({ ...periodicCfg, periodic: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(invoker).toHaveBeenCalledTimes(1);

    m.saveAutoSyncConfig({ ...periodicCfg, periodic: true, intervalSecs: 600 });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(invoker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it("周期同步与写入防抖互不干扰：防抖轮进行中时周期拍跳过", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig({ ...periodicCfg, syncAfterWrite: true, delaySecs: 5 });

    let resolveRun!: (v: unknown) => void;
    invoker.mockImplementationOnce(() => new Promise((r) => (resolveRun = r)));

    m.markLocalWrite("doc_save");
    await vi.advanceTimersByTimeAsync(5_000); // 防抖到期：run_sync 开始且未结束
    expect(invoker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000); // 周期拍撞上进行中的 sync：跳过
    expect(invoker).toHaveBeenCalledTimes(1);

    resolveRun({ action: "idle", pulled: false });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it("休眠超周期后回前台：不等下一拍，立刻补跑一轮", async () => {
    const m = await freshAutoSync();
    m.startAutoSync();
    m.saveAutoSyncConfig(periodicCfg);
    const onVis = docListeners.get("visibilitychange");
    expect(onVis).toBeTypeOf("function");

    await vi.advanceTimersByTimeAsync(300_000); // 正常一拍，lastSyncAt 落表
    expect(invoker).toHaveBeenCalledTimes(1);

    docStub.visibilityState = "hidden";
    vi.setSystemTime(Date.now() + 100_000); // 休眠 100s（定时器冻结，不产生拍）
    onVis!(); // hidden 时不响应
    expect(invoker).toHaveBeenCalledTimes(1);

    docStub.visibilityState = "visible";
    onVis!(); // 距上次同步仅 100s < 300s：不该补
    expect(invoker).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 200_000); // 累计 300s：超周期
    docStub.visibilityState = "visible";
    onVis!(); // 回前台立刻补跑，不等 interval 下一拍
    await vi.advanceTimersByTimeAsync(0);
    expect(invoker).toHaveBeenCalledTimes(2);
  });
});
