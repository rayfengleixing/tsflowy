import { describe, expect, it } from "vitest";
import {
  VIRTUAL_OVERSCAN,
  computeWindowFromHeights,
  lineHeightsOf,
  offsetOfHeights,
  type GridFlatLine,
} from "./grid-view-helpers";
import type { DatabaseRow } from "@/types/database";

const rowLine = (id: string): GridFlatLine => ({ kind: "row", row: { id } as DatabaseRow });
const headerLine = (key: string, depth = 0): GridFlatLine => ({
  kind: "header",
  key,
  depth,
  label: key,
  count: 2,
  collapsed: false,
});
const subtotalLine = (key: string): GridFlatLine => ({ kind: "subtotal", key, rowIds: [] });

describe("lineHeightsOf / offsetOfHeights", () => {
  it("三种条目各用各自高度", () => {
    const lines = [headerLine("g1"), rowLine("a"), rowLine("b"), subtotalLine("g1")];
    expect(lineHeightsOf(lines, 32, 26, 24)).toEqual([26, 32, 32, 24]);
  });

  it("offsetOfHeights 累加前 index 条", () => {
    const heights = [10, 20, 30];
    expect(offsetOfHeights(heights, 0)).toBe(0);
    expect(offsetOfHeights(heights, 2)).toBe(30);
    expect(offsetOfHeights(heights, 5)).toBe(60);
  });
});

describe("computeWindowFromHeights（分组窗口化）", () => {
  const heights = lineHeightsOf(
    [headerLine("g1"), rowLine("a"), rowLine("b"), subtotalLine("g1"), headerLine("g2"), rowLine("c"), rowLine("d")],
    32,
    26,
    24,
  );

  it("顶部对齐时窗口从第一条开始（含下缘）", () => {
    const { start, end } = computeWindowFromHeights({ scrollTop: 26, dataTop: 0, clientHeight: 80, heights });
    // 视口 [26,106)：条目 1..3 部分可见
    expect(start).toBe(0); // overscan 夹回
    expect(end).toBeGreaterThanOrEqual(4);
  });

  it("overscan 上下各多算 VIRTUAL_OVERSCAN 条", () => {
    const w = computeWindowFromHeights({ scrollTop: 500, dataTop: 0, clientHeight: 100, heights });
    expect(w.start).toBe(0);
    expect(w.end).toBe(heights.length); // 条目总数小于 2×overscan+视口 时全窗口
  });

  it("overscan 生效：窗口外仍带出邻近条目", () => {
    const tall: number[] = Array.from({ length: 500 }, () => 32);
    const { start, end } = computeWindowFromHeights({ scrollTop: 3200, dataTop: 0, clientHeight: 320, heights: tall });
    expect(start).toBe(100 - VIRTUAL_OVERSCAN);
    expect(end).toBe(Math.min(tall.length, 110 + VIRTUAL_OVERSCAN));
  });

  it("end 恒大于 start", () => {
    const { start, end } = computeWindowFromHeights({ scrollTop: 0, dataTop: 1000, clientHeight: 0, heights });
    expect(end).toBeGreaterThan(start);
  });
});
