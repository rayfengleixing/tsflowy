import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 巡检只有一个调用点（App 启动后），但它的"什么时候吵用户、什么时候闭嘴"
// 正好是这类功能最容易被写坏的地方：库本来打不开时兜底页已经在管了，
// 巡检再弹一条就成重复告警。这里把这几条边界钉住。
const invokeMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
const setRouteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/invoke", () => ({ invoke: invokeMock }));
vi.mock("sonner", () => ({
  toast: { warning: warnMock, success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const healthy = {
  ok: true,
  deep: false,
  took_ms: 12,
  db_path: "D:/data/appflowy.db",
  db_size_bytes: 4096,
  messages: ["ok"],
};
const broken = { ...healthy, ok: false, messages: ["btree3: page 3 is not a valid btree leaf page"] };

/** 模块级的一次性闸门会跨用例生效：每个用例都要重新取一份模块 */
async function freshModule() {
  vi.resetModules();
  // resetModules 把 app-context 也换成新的一份，注册表得在同一份上重新绑：
  // 告警按钮的「去设置」现在走写侧注册表（lib/app-context），不再直接拿 workspace store
  const { bindAppActions } = await import("../app-context");
  bindAppActions({ setRoute: setRouteMock });
  return await import("./db-health");
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  warnMock.mockReset();
  setRouteMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("启动后的数据库健康巡检", () => {
  it("等到延迟到期才查：不与首屏渲染和自动同步抢磁盘 I/O", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue(healthy);
    const p = m.probeDbHealthOnStartup();
    await vi.advanceTimersByTimeAsync(m.PROBE_DELAY_MS - 1);
    expect(invokeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeMock).toHaveBeenCalledWith("check_db_integrity", { deep: false });
    await expect(p).resolves.toEqual(healthy);
  });

  it("一切正常时不出声", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue(healthy);
    // 先把探针挂上再推进计时器：await 一个等定时器的 promise 会把测试自己锁死
    const p = m.probeDbHealthOnStartup(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("查出异常给一条可跳转的告警，按钮把用户带到设置页", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue(broken);
    const p = m.probeDbHealthOnStartup(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [title, opts] = warnMock.mock.calls[0] as [string, { description: string; action: { onClick: () => void } }];
    expect(typeof title).toBe("string");
    expect(title).toBeTruthy();
    expect(opts.description).toBe(broken.messages[0]);
    expect(setRouteMock).not.toHaveBeenCalled();
    opts.action.onClick();
    expect(setRouteMock).toHaveBeenCalledWith("settings");
  });

  it("一次启动只查一遍（React 严格模式会重复挂载）", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue(healthy);
    const first = m.probeDbHealthOnStartup(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual(healthy);
    await expect(m.probeDbHealthOnStartup(1)).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("命令本身失败时不重复告警：库连打开都失败，兜底页已经在管了", async () => {
    const m = await freshModule();
    invokeMock.mockRejectedValue(new Error("database is closed"));
    const p = m.probeDbHealthOnStartup(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeNull();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("修复的四种结局都有文案，不漏一种", async () => {
    const m = await freshModule();
    for (const action of ["none", "wal", "rebuild", "failed"] as const) {
      expect(m.REPAIR_ACTION_KEY[action], `修复结局 ${action} 忘了配文案`).toBeTruthy();
    }
  });

  it("修复命令走 repair_database，不带参数", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue({ action: "none" });
    await m.repairDatabase();
    expect(invokeMock).toHaveBeenCalledWith("repair_database");
  });
});
