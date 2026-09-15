import type { CellValue, DatabaseField, FieldType } from "@/types/database";
import { formatCellValue, formatNumber, parseFieldOptions } from "./database-values";
import { isCellEmpty } from "./database-query";
import { t } from "@/lib/i18n";

// 列汇总（表格底部一行 + 分组小计复用同一套函数）。
// 全部是纯函数：输入"参与统计的行 id"，输出展示用字符串，所以分组小计与全表汇总走同一条路径。

export type AggregateFn =
  "count" | "filled" | "empty" | "unique" | "sum" | "average" | "min" | "max" | "checked" | "unchecked";

const DATEISH: FieldType[] = ["date", "created_at", "last_edited_at"];

/** extra 校验用的运行时清单：新增函数只改这里和 AggregateFn */
export const AGGREGATE_FNS: AggregateFn[] = [
  "count",
  "filled",
  "empty",
  "unique",
  "sum",
  "average",
  "min",
  "max",
  "checked",
  "unchecked",
];

/** extra 里的字符串能不能当汇总函数用 */
export function isAggregateFn(v: unknown): v is AggregateFn {
  return typeof v === "string" && (AGGREGATE_FNS as string[]).includes(v);
}

/** 字段类型能算哪些汇总（UI 菜单据此列出选项，避免给文本列摆"求和"） */
export function aggregatesForType(type: FieldType): AggregateFn[] {
  if (type === "number") return ["count", "filled", "empty", "unique", "sum", "average", "min", "max"];
  if (type === "checkbox") return ["count", "checked", "unchecked"];
  if (DATEISH.includes(type)) return ["count", "filled", "empty", "unique", "min", "max"];
  return ["count", "filled", "empty", "unique"];
}

/** 类型切换后原选择可能不再适用：不在候选里就回落到计数 */
export function normalizeAggregate(type: FieldType, fn: AggregateFn | undefined): AggregateFn | undefined {
  if (!fn) return undefined;
  return aggregatesForType(type).includes(fn) ? fn : "count";
}

export function aggregateLabel(fn: AggregateFn): string {
  return t(`aggregate.${fn}`);
}

function cellValues(rowIds: string[], fieldId: string, cells: Record<string, Record<string, CellValue>>): CellValue[] {
  return rowIds.map((id) => cells[id]?.[fieldId] ?? null);
}

function toNumber(value: CellValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 数字按字段自身格式展示（百分比/货币沿用列设置） */
function formatAsNumber(field: DatabaseField, n: number): string {
  const opts = parseFieldOptions(field.options);
  return formatNumber(
    n,
    opts.kind === "number" ? opts : { kind: "number", format: "decimal", precision: 2, currency: "CNY" },
  );
}

function formatDateish(field: DatabaseField, values: string[], pick: "min" | "max"): string {
  const sorted = [...values].sort(); // ISO 串按字典序即时间序
  const iso = pick === "min" ? sorted[0] : sorted[sorted.length - 1];
  return iso ? formatCellValue(field.field_type, iso, parseFieldOptions(field.options)) : "";
}

/**
 * 汇总值 → 展示文本。rowIds 为空时计数类返回 "0"，取值类返回 ""（无意义不硬凑 0）。
 * "none" 由调用方处理：这里不接受，避免把"没配置"和"配置成无"混为一谈。
 */
export function aggregateValue(
  fn: AggregateFn,
  field: DatabaseField,
  rowIds: string[],
  cells: Record<string, Record<string, CellValue>>,
): string {
  const values = cellValues(rowIds, field.id, cells);
  const filled = values.filter((v) => !isCellEmpty(v));
  switch (fn) {
    case "count":
      return String(rowIds.length);
    case "filled":
      return String(filled.length);
    case "empty":
      return String(rowIds.length - filled.length);
    case "unique":
      return String(
        new Set(filled.map((v) => formatCellValue(field.field_type, v, parseFieldOptions(field.options)))).size,
      );
    case "checked":
      return String(values.filter((v) => v === true).length);
    case "unchecked":
      return String(values.filter((v) => v !== true).length);
  }
  if (fn === "sum" || fn === "average") {
    const nums = filled.map(toNumber).filter((n): n is number => n !== null);
    if (nums.length === 0) return fn === "sum" ? "0" : "";
    const total = nums.reduce((a, b) => a + b, 0);
    return formatAsNumber(field, fn === "sum" ? total : total / nums.length);
  }
  // min / max：候选项只给数字列和日期列（见 aggregatesForType）
  if (DATEISH.includes(field.field_type)) {
    const iso = filled.filter((v): v is string => typeof v === "string" && v !== "");
    return formatDateish(field, iso, fn === "min" ? "min" : "max");
  }
  const nums = filled.map(toNumber).filter((n): n is number => n !== null);
  if (nums.length === 0) return "";
  return formatAsNumber(field, fn === "min" ? Math.min(...nums) : Math.max(...nums));
}
