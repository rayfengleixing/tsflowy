import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/invoke", () => ({ invoke: invokeMock }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  clampRetention,
  fetchRetentionPolicy,
  normalizeRetentionPolicy,
  RETENTION_DEFAULTS,
  RETENTION_LIMITS,
  trashDeadlineMs,
} from "./retention";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("clampRetention", () => {
  it("区间内的值保留，小数按四舍五入", () => {
    expect(clampRetention(7, RETENTION_LIMITS.trash_retention_days)).toBe(7);
    expect(clampRetention(7.6, RETENTION_LIMITS.trash_retention_days)).toBe(8);
  });

  it("越界值夹到边界", () => {
    expect(clampRetention(2000, RETENTION_LIMITS.snapshot_interval_minutes)).toBe(1440);
    expect(clampRetention(9999, RETENTION_LIMITS.snapshot_keep)).toBe(500);
    expect(clampRetention(9999, RETENTION_LIMITS.snapshot_pre_restore_keep)).toBe(50);
    expect(clampRetention(9999, RETENTION_LIMITS.trash_retention_days)).toBe(365);
    // 取整后低于下限：夹到下限而不是回落默认（0 本身才走回落）
    expect(clampRetention(0.4, RETENTION_LIMITS.snapshot_interval_minutes)).toBe(1);
  });

  it("空值 / 非数 / 非正数回落默认值", () => {
    for (const limit of Object.values(RETENTION_LIMITS)) {
      expect(clampRetention(undefined, limit)).toBe(limit.fallback);
      expect(clampRetention(null, limit)).toBe(limit.fallback);
      expect(clampRetention(NaN, limit)).toBe(limit.fallback);
      expect(clampRetention(Infinity, limit)).toBe(limit.fallback);
      expect(clampRetention(0, limit)).toBe(limit.fallback);
      expect(clampRetention(-5, limit)).toBe(limit.fallback);
    }
  });
});

describe("normalizeRetentionPolicy", () => {
  it("缺字段逐项回落默认值", () => {
    expect(normalizeRetentionPolicy({})).toEqual(RETENTION_DEFAULTS);
    expect(normalizeRetentionPolicy(null)).toEqual(RETENTION_DEFAULTS);
    expect(normalizeRetentionPolicy({ trash_retention_days: 90 })).toEqual({
      ...RETENTION_DEFAULTS,
      trash_retention_days: 90,
    });
  });

  it("完整且合法的配置原样返回", () => {
    const full = {
      snapshot_interval_minutes: 15,
      snapshot_keep: 100,
      snapshot_pre_restore_keep: 3,
      trash_retention_days: 60,
    };
    expect(normalizeRetentionPolicy(full)).toEqual(full);
  });
});

describe("fetchRetentionPolicy", () => {
  // 每个用例各自设定 invoke 的实现：加 beforeEach(() => invokeMock.mockReset()) 会让
  // 被内部 catch 掉的 reject 当成未捕获错误报出（Vitest 4.1 实测），整组用例直接失败。
  it("命令名走 get_retention_policy，越界值同样夹回合法区间", async () => {
    invokeMock.mockResolvedValue({
      snapshot_interval_minutes: 30,
      snapshot_keep: 5000,
      snapshot_pre_restore_keep: 5,
      trash_retention_days: 30,
    });
    expect(await fetchRetentionPolicy()).toEqual({
      snapshot_interval_minutes: 30,
      snapshot_keep: 500,
      snapshot_pre_restore_keep: 5,
      trash_retention_days: 30,
    });
    expect(invokeMock.mock.lastCall?.[0]).toBe("get_retention_policy");
  });

  it("IPC 失败回落全默认值而不是抛错（自动清理不能停摆）", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    expect(await fetchRetentionPolicy()).toEqual(RETENTION_DEFAULTS);
  });
});

describe("trashDeadlineMs", () => {
  it("按配置的天数往前推", async () => {
    invokeMock.mockResolvedValue({ trash_retention_days: 3 });
    const now = 1_700_000_000_000;
    expect(await trashDeadlineMs(now)).toBe(now - 3 * DAY_MS);
  });

  it("读不到配置时按默认 30 天", async () => {
    invokeMock.mockRejectedValue(new Error("db closed"));
    const now = 1_700_000_000_000;
    expect(await trashDeadlineMs(now)).toBe(now - 30 * DAY_MS);
  });
});
