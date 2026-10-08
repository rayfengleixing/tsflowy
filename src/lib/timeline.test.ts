import { describe, expect, it } from "vitest";
import { DAY_MS, MAX_TICKS, addUnit, autoScale, buildAxis, floorToScale, parseDateKey, tickLabel } from "./timeline";

// 期望值统一用本地 Date 构造，避免依赖运行机的时区设置

describe("parseDateKey", () => {
  it("解析 YYYY-MM-DD 为本地零点", () => {
    expect(parseDateKey("2026-10-08")).toBe(new Date(2026, 9, 8).getTime());
  });

  it("忽略尾部的时间部分", () => {
    expect(parseDateKey("2026-10-08T13:20:00")).toBe(new Date(2026, 9, 8).getTime());
  });

  it("非法输入返回 null", () => {
    expect(parseDateKey("")).toBeNull();
    expect(parseDateKey("not-a-date")).toBeNull();
    expect(parseDateKey("2026/10/08")).toBeNull();
  });
});

describe("floorToScale", () => {
  it("day 下取整到当天零点", () => {
    const ms = new Date(2026, 9, 8, 15, 30).getTime();
    expect(floorToScale(ms, "day")).toBe(new Date(2026, 9, 8).getTime());
  });

  it("week 下取整到所在周的周一", () => {
    // 2026-10-08 是周四 → 周一为 2026-10-05
    const ms = new Date(2026, 9, 8, 9, 0).getTime();
    expect(floorToScale(ms, "week")).toBe(new Date(2026, 9, 5).getTime());
  });

  it("month 下取整到月初", () => {
    const ms = new Date(2026, 9, 8, 9, 0).getTime();
    expect(floorToScale(ms, "month")).toBe(new Date(2026, 9, 1).getTime());
  });
});

describe("addUnit", () => {
  it("day 推进一天", () => {
    expect(addUnit("day", new Date(2026, 9, 8).getTime())).toBe(new Date(2026, 9, 9).getTime());
  });

  it("week 推进七天", () => {
    expect(addUnit("week", new Date(2026, 9, 5).getTime())).toBe(new Date(2026, 9, 12).getTime());
  });

  it("month 推进到下一个月初（跨年）", () => {
    expect(addUnit("month", new Date(2026, 11, 1).getTime())).toBe(new Date(2027, 0, 1).getTime());
  });
});

describe("tickLabel", () => {
  it("month 粒度显示 年/月", () => {
    expect(tickLabel("month", new Date(2026, 9, 1).getTime())).toBe("2026/10");
  });

  it("day/week 粒度显示 月/日", () => {
    expect(tickLabel("day", new Date(2026, 9, 8).getTime())).toBe("10/8");
    expect(tickLabel("week", new Date(2026, 9, 5).getTime())).toBe("10/5");
  });
});

describe("autoScale", () => {
  it("按跨度分档：≤21 天用 day、≤120 天用 week、更长用 month", () => {
    expect(autoScale(0)).toBe("day");
    expect(autoScale(21)).toBe("day");
    expect(autoScale(22)).toBe("week");
    expect(autoScale(120)).toBe("week");
    expect(autoScale(121)).toBe("month");
  });
});

describe("buildAxis", () => {
  it("首刻度落在域起点，跨度非零，覆盖到（不小于）max", () => {
    const min = new Date(2026, 9, 3).getTime(); // 2026-10-03 周六
    const max = new Date(2026, 9, 20).getTime();
    const axis = buildAxis({ min, max }, "week");
    expect(axis.domainStart).toBe(new Date(2026, 8, 28).getTime()); // 所在周周一（9/28）
    expect(axis.span).toBeGreaterThan(0);
    expect(axis.domainStart + axis.span).toBeGreaterThanOrEqual(max);
    expect(axis.ticks[0].pct).toBe(0);
    expect(axis.ticks[0].label).toBe("9/28");
  });

  it("刻度按粒度逐个推进，pct 单调不减", () => {
    const min = new Date(2026, 9, 1).getTime();
    const max = new Date(2026, 9, 3).getTime();
    const axis = buildAxis({ min, max }, "day");
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < axis.ticks.length; i++) {
      expect(axis.ticks[i].pct).toBeGreaterThanOrEqual(axis.ticks[i - 1].pct);
    }
  });

  it("极窄域退化为一天，不产生除零", () => {
    const ms = new Date(2026, 9, 8).getTime();
    const axis = buildAxis({ min: ms, max: ms }, "day");
    expect(axis.span).toBe(DAY_MS);
    expect(Number.isFinite(axis.span)).toBe(true);
  });

  it("刻度数受 MAX_TICKS 兜底", () => {
    const min = new Date(1900, 0, 1).getTime();
    const max = new Date(2026, 0, 1).getTime();
    const axis = buildAxis({ min, max }, "day");
    expect(axis.ticks.length).toBeLessThanOrEqual(MAX_TICKS + 1);
  });
});
