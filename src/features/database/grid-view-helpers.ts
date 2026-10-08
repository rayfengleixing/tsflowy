import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { computeFormula } from "@/lib/database-formula";
import { computeReverseRelation, computeRollup, type RelationDb } from "@/lib/relation";

// GridView 的纯计算/工具函数与常量：从 GridView.tsx 原样搬出（无逻辑改动），
// 便于单测这些与 React 无关的取值/窗口计算。

/** 窗口化阈值：行数超过它才启用（小表保持全量渲染，零行为差异） */
export const VIRTUAL_MIN_ROWS = 150;
/** 行高兜底值（td h-8 = 32px）：首次测量前用，测量后以真实行高为准 */
export const ROW_H_FALLBACK = 32;
/** 视口上下各多渲染的行数：抵消快速滚动时的白屏 */
export const VIRTUAL_OVERSCAN = 12;

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
 * 公式/汇总/反向关系字段没有存储值：把求值结果提前算进一份"有效单元格"图，排序/列汇总/分组小计都读它，
 * 否则按这些列排序排不动（raw 恒为空值）、汇总恒为空。没有这类字段时直接复用原始 cells。
 */
export function computeEvaluatedCells(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  fields: DatabaseField[],
  relationDbOf: (viewId: string) => RelationDb | undefined,
): Record<string, Record<string, CellValue>> {
  const hasComputed = fields.some(
    (f) => f.field_type === "formula" || f.field_type === "rollup" || f.field_type === "reverse_relation",
  );
  if (!hasComputed) return cells;
  const out: Record<string, Record<string, CellValue>> = {};
  for (const row of rows) {
    const rowCells = cells[row.id] ?? {};
    let copy: Record<string, CellValue> | null = null;
    for (const f of fields) {
      if (f.field_type === "formula") {
        const v = computeFormula(f, rowCells, fields);
        if (v !== null) (copy ??= { ...rowCells })[f.id] = v;
      } else if (f.field_type === "rollup") {
        const v = computeRollup(f, rowCells, fields, relationDbOf);
        if (v !== null) {
          // 数字样式的汇总值转成 number：排序才是数值序（"9.00" 不会排在 "42.50" 之后）
          const n = Number(v);
          (copy ??= { ...rowCells })[f.id] = v.trim() !== "" && Number.isFinite(n) ? n : v;
        }
      } else if (f.field_type === "reverse_relation") {
        // 反向关系：实时反查来源行，值为来源行 id 数组（可参与排序/汇总）
        const v = computeReverseRelation(row.id, f, relationDbOf);
        if (v !== null) (copy ??= { ...rowCells })[f.id] = v;
      }
    }
    out[row.id] = copy ?? rowCells;
  }
  return out;
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
