import type { DatabaseRow } from "@/types/database";

// GridView 的纯计算/工具函数与常量：从 GridView.tsx 原样搬出（无逻辑改动），
// 便于单测这些与 React 无关的取值/窗口计算。
// 计算列求值（computeEvaluatedCells）已提为 Grid/Board/Calendar/Timeline 共用，见 @/lib/database-evaluated-cells。

/** 窗口化阈值：行数超过它才启用（小表保持全量渲染，零行为差异） */
export const VIRTUAL_MIN_ROWS = 150;
/** 行高兜底值（td h-8 = 32px）：首次测量前用，测量后以真实行高为准 */
export const ROW_H_FALLBACK = 32;
/** 组头/小计行高兜底值：与数据行同法，先测量再采用 */
export const GROUP_LINE_H_FALLBACK = 28;
/** 视口上下各多渲染的行数：抵消快速滚动时的白屏 */
export const VIRTUAL_OVERSCAN = 12;

/**
 * 分组模式把组头/数据行/小计摊平成一行行，窗口化按线性条目统一处理；组头带层级用于缩进。
 * 数据行在未分组且本表存在父子层级时额外带上层深与折叠状态（见 lib/database-hierarchy.ts）；
 * 没有层级关系时这三个字段缺省，渲染路径与改造前完全一致。
 */
export type GridFlatLine =
  | { kind: "header"; key: string; depth: number; label: string; count: number; collapsed: boolean }
  | { kind: "row"; row: DatabaseRow; depth?: number; hasChildren?: boolean; collapsed?: boolean }
  | { kind: "subtotal"; key: string; rowIds: string[] };

/** 每条线性条目的高度（组头/小计各自用实测值；非分组走均一数据行高的快路径） */
export function lineHeightsOf(lines: GridFlatLine[], rowH: number, headerH: number, subtotalH: number): number[] {
  return lines.map((l) => (l.kind === "row" ? rowH : l.kind === "header" ? headerH : subtotalH));
}

/** 前 index 条行的总高度 */
export function offsetOfHeights(heights: number[], index: number): number {
  let sum = 0;
  for (let i = 0; i < index && i < heights.length; i++) sum += heights[i];
  return sum;
}

/** 列宽裁剪：落库前后统一夹在 60–600px */
export function clampColumnWidth(w: number): number {
  return Math.max(60, Math.min(600, w));
}

/** 键盘光标的单元格选择器：按行 id + 字段 id 定位 */
export function cellSelector(c: { rowId: string; fieldId: string }): string {
  return `[data-cell-row="${c.rowId}"][data-cell-field="${c.fieldId}"]`;
}

/**
 * 窗口化区间：按滚动位置、数据区 y 偏移与行高折算应渲染的行区间（含上下 overscan）。
 * end 至少比 start 多 1，避免量出空窗口。
 */
export function computeVirtualWindow(p: {
  scrollTop: number;
  dataTop: number;
  clientHeight: number;
  total: number;
  rowHeight: number;
}): { start: number; end: number } {
  const start = Math.max(0, Math.floor((p.scrollTop - p.dataTop) / p.rowHeight) - VIRTUAL_OVERSCAN);
  const end = Math.min(p.total, Math.ceil((p.scrollTop - p.dataTop + p.clientHeight) / p.rowHeight) + VIRTUAL_OVERSCAN);
  return { start, end: Math.max(end, Math.min(p.total, start + 1)) };
}

/**
 * 变高行版本的窗口化：heights 为每条线性条目的高度，先定位视口顶所在条目，
 * 再向下累加到视口底，前后各加 overscan 条。
 */
export function computeWindowFromHeights(p: {
  scrollTop: number;
  dataTop: number;
  clientHeight: number;
  heights: number[];
}): { start: number; end: number } {
  const view = Math.max(0, p.scrollTop - p.dataTop);
  let acc = 0;
  let start = 0;
  while (start < p.heights.length && acc + p.heights[start] <= view) {
    acc += p.heights[start];
    start++;
  }
  start = Math.max(0, start - VIRTUAL_OVERSCAN);
  let y = offsetOfHeights(p.heights, start);
  let end = start;
  while (end < p.heights.length && y < view + p.clientHeight) {
    y += p.heights[end];
    end++;
  }
  end = Math.min(p.heights.length, end + VIRTUAL_OVERSCAN);
  return { start, end: Math.max(end, Math.min(p.heights.length, start + 1)) };
}

/** 有并发上限的异步遍历：附件列复制时避免 N 行 × M 个附件同时发起 save_asset 打爆磁盘 I/O */
export async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
