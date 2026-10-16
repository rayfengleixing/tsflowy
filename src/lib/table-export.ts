import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { fieldKind, isComputedKind } from "./field-kinds";
import { isOptionBearing, parseFieldOptions, sparseGet } from "./database-values";
import { cellAt } from "./database-query";
import { cellToCsv, selectCellToText } from "./csv";
import { relationCellText, relationTarget, type RelationDb } from "./relation";

// 表格视图的导出取值层：CSV / xlsx 共用同一份「单元格 → 可导出值」规则，
// 否则两种格式对同一张表会给出不同的文本（relation 分隔符、选项名翻译、计算列取值各写一遍就漂移）。

/**
 * 计算列没有存储值，导出前先折成一份"有效单元格"图：
 * - relation / reverse_relation：行 id 翻成对端行标题（导出的文件才对人可读）；
 * - formula / rollup：取渲染期算好的展示值。
 * 其余字段原样透传（返回同一份 cells 引用，不复制没被改的行）。
 */
export function resolveExportCells(
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  displayCells: Record<string, Record<string, CellValue>>,
  relationDbOf: (viewId: string) => RelationDb | undefined,
): Record<string, Record<string, CellValue>> {
  const out: Record<string, Record<string, CellValue>> = { ...cells };
  // 导出用「; 」分隔：值里带逗号时不会与 CSV 分隔符混淆（看板/卡片那套展示用默认 ", "）
  const labels = (value: CellValue, db: RelationDb | undefined): string => relationCellText(value, db, "; ");
  for (const row of rows) {
    for (const field of fields) {
      let value: CellValue | undefined;
      if (field.field_type === "relation") {
        value = labels(cellAt(cells, row.id, field.id), relationDbOf(relationTarget(field) ?? ""));
      } else if (field.field_type === "reverse_relation") {
        // 反向关系无存储值：来源行 id 同样翻成标题
        const cfg = parseFieldOptions(field.options);
        const db = cfg.kind === "reverse_relation" ? relationDbOf(cfg.source_view_id) : undefined;
        const text = labels(cellAt(displayCells, row.id, field.id), db);
        if (text !== "") value = text;
      } else if (isComputedKind(field.field_type)) {
        // formula / rollup（reverse_relation 已在上面单独处理）：取渲染期算好的展示值
        const v = cellAt(displayCells, row.id, field.id);
        if (v !== null) value = v;
      }
      if (value !== undefined) out[row.id] = { ...(sparseGet(out, row.id) ?? {}), [field.id]: value };
    }
  }
  return out;
}

/** xlsx 列种类（与 Rust 侧 XlsxKind 的 camelCase 取值一一对应） */
export type XlsxKind = "text" | "number" | "bool" | "date" | "datetime";
export type XlsxCell = string | number | boolean | null;

export interface XlsxColumn {
  header: string;
  kind: XlsxKind;
}

export interface XlsxSheetPayload {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxCell[][];
}

/**
 * 列种类只由字段类型的值语义域决定：数字族走数值、布尔域走勾选、日期域按字段 options 决定带不带时刻。
 * 系统时间戳（created_at/last_edited_at）没有 date 配置，自然落到只到日的分支，与网格展示口径一致。
 */
export function xlsxKindOf(field: DatabaseField): XlsxKind {
  const domain = fieldKind(field.field_type).domain;
  if (domain === "number") return "number";
  if (domain === "boolean") return "bool";
  if (domain === "date") {
    const opts = parseFieldOptions(field.options);
    return opts.kind === "date" && opts.include_time ? "datetime" : "date";
  }
  return "text";
}

/**
 * 时间戳 → 墙上时间文本（`YYYY-MM-DD[ ]HH:MM:SS`），口径与网格显示同一条：
 * 无时区后缀的存储串按 UTC 解释后再按本地展示，序列号由 Rust 侧按文本算，这里不碰时区。
 * 解析不了返回 null，调用方按原文本导出。
 */
export function dateToWallClock(value: CellValue, includeTime: boolean): string | null {
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value.endsWith("Z") ? value : value + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!includeTime) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 选项 id / 附件数组 → 文本（与 CSV 共用同一份取值规则，两种导出格式对同一格给同一个串） */
function cellToText(field: DatabaseField, value: CellValue): string {
  if (isOptionBearing(field.field_type)) {
    const opts = parseFieldOptions(field.options);
    if (opts.kind === "select") return selectCellToText(value, opts.options);
  }
  return cellToCsv(field.field_type, value);
}

/** 一格 → xlsx 载荷值；数字/布尔/日期给真类型值以便在 Excel 里排序求和，其余落到 CSV 的文本口径 */
function xlsxCellValue(field: DatabaseField, value: CellValue, kind: XlsxKind): XlsxCell {
  if (value === null) return null;
  if (kind === "number") return typeof value === "number" && Number.isFinite(value) ? value : null;
  if (kind === "bool") return typeof value === "boolean" ? value : null;
  // 计算列折出来的值可能本身就是数字（公式结果），保留数值形态
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cellToText(field, value);
  if (kind === "date" || kind === "datetime") return dateToWallClock(text, kind === "datetime") ?? text;
  return text;
}

/** 当前视图 → 单表工作簿载荷（隐藏列不导出，与 CSV 同口径；行序由调用方给 displayRows） */
export function buildXlsxSheet(
  sheetName: string,
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
): XlsxSheetPayload {
  const columns = fields.filter((f) => f.is_hidden === 0);
  const kinds = columns.map(xlsxKindOf);
  return {
    name: sheetName,
    columns: columns.map((f, i) => ({ header: f.name, kind: kinds[i] })),
    rows: rows.map((row) => columns.map((f, i) => xlsxCellValue(f, cellAt(cells, row.id, f.id), kinds[i]))),
  };
}

/** 视图名 → 保存对话框的默认文件名：Windows 保留字符一律换成 `_`，空名回落到 export */
export function exportFileName(raw: string, ext: string): string {
  const base = raw.replace(/[\\/:*?"<>|]/g, "_").trim();
  return `${base === "" ? "export" : base}.${ext}`;
}
