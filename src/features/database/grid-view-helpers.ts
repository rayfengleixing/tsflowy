import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { computeRowFormulas } from "@/lib/database-formula";
import { computeReverseRelation, computeRollup, type RelationDb } from "@/lib/relation";

// GridView 的纯计算/工具函数与常量：从 GridView.tsx 原样搬出（无逻辑改动），
// 便于单测这些与 React 无关的取值/窗口计算。

/** 窗口化阈值：行数超过它才启用（小表保持全量渲染，零行为差异） */
export const VIRTUAL_MIN_ROWS = 150;
/** 行高兜底值（td h-8 = 32px）：首次测量前用，测量后以真实行高为准 */
export const ROW_H_FALLBACK = 32;
/** 组头/小计行高兜底值：与数据行同法，先测量再采用 */
export const GROUP_LINE_H_FALLBACK = 28;
/** 视口上下各多渲染的行数：抵消快速滚动时的白屏 */
export const VIRTUAL_OVERSCAN = 12;

/** 分组模式把组头/数据行/小计摊平成一行行，窗口化按线性条目统一处理 */
export type GridFlatLine =
  | { kind: "header"; key: string; label: string; count: number; collapsed: boolean }
  | { kind: "row"; row: DatabaseRow }
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

/** 把某一行滚动到视口中央所需的 scrollTop（虚拟窗口外的行先滚过去再聚焦） */
export function rowCenterScrollTop(p: {
  dataTop: number;
  index: number;
  rowHeight: number;
  clientHeight: number;
}): number {
  return Math.max(0, p.dataTop + p.index * p.rowHeight - p.clientHeight / 2);
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

/**
 * 公式/汇总/反向关系字段没有存储值：把求值结果提前算进一份"有效单元格"图，排序/列汇总/分组小计都读它，
 * 否则按这些列排序排不动（raw 恒为空值）、汇总恒为空。没有这类字段时直接复用原始 cells。
 *
 * 一次遍历产出两份图：
 * - sortable：数值样式的汇总值转成 number（"9.00" 不会按字典序排在 "42.50" 之后），供排序/筛选/聚合；
 * - display：保留展示文本（rollup 带精度/货币格式），供网格单元格直读——行渲染不再逐格重算。
 */
export function computeEvaluatedCells(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  fields: DatabaseField[],
  relationDbOf: (viewId: string) => RelationDb | undefined,
): { sortable: Record<string, Record<string, CellValue>>; display: Record<string, Record<string, CellValue>> } {
  const hasComputed = fields.some(
    (f) => f.field_type === "formula" || f.field_type === "rollup" || f.field_type === "reverse_relation",
  );
  if (!hasComputed) return { sortable: cells, display: cells };
  const hasFormula = fields.some((f) => f.field_type === "formula");
  const sortable: Record<string, Record<string, CellValue>> = {};
  const display: Record<string, Record<string, CellValue>> = {};
  for (const row of rows) {
    const rowCells = cells[row.id] ?? {};
    // 每行一次建图：公式串公式按依赖序取计算值，环成员得 #CYCLE
    const formulaValues = hasFormula ? computeRowFormulas(rowCells, fields) : null;
    let sortCopy: Record<string, CellValue> | null = null;
    let displayCopy: Record<string, CellValue> | null = null;
    for (const f of fields) {
      if (f.field_type === "formula") {
        const v = formulaValues?.get(f.id) ?? null;
        if (v !== null) {
          (sortCopy ??= { ...rowCells })[f.id] = v;
          (displayCopy ??= { ...rowCells })[f.id] = v;
        }
      } else if (f.field_type === "rollup") {
        const v = computeRollup(f, rowCells, fields, relationDbOf);
        if (v !== null) {
          const n = Number(v);
          (sortCopy ??= { ...rowCells })[f.id] = v.trim() !== "" && Number.isFinite(n) ? n : v;
          (displayCopy ??= { ...rowCells })[f.id] = v;
        }
      } else if (f.field_type === "reverse_relation") {
        // 反向关系：实时反查来源行，值为来源行 id 数组（可参与排序/汇总）
        const v = computeReverseRelation(row.id, f, relationDbOf);
        if (v !== null) {
          (sortCopy ??= { ...rowCells })[f.id] = v;
          (displayCopy ??= { ...rowCells })[f.id] = v;
        }
      }
    }
    sortable[row.id] = sortCopy ?? rowCells;
    display[row.id] = displayCopy ?? rowCells;
  }
  return { sortable, display };
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
