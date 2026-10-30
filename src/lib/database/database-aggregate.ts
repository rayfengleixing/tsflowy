import type { CellValue, DatabaseField, FieldType } from "@/types/database";
import { formatCellValue, formatNumber, parseFieldOptions } from "./database-values";
import { cellAt, isCellEmpty } from "./database-query";
import { isDateKind } from "./field-kinds";
import { t } from "@/lib/i18n";

// 列汇总（表格底部一行 + 分组小计复用同一套函数）。
// 全部是纯函数：输入"参与统计的行 id"，输出展示用字符串，所以分组小计与全表汇总走同一条路径。

export type AggregateFn =
  | "count"
  | "filled"
  | "empty"
  | "unique"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "checked"
  | "unchecked"
  | "share";

/** 数值列：能求和/取中位数的类型（formula 展示时已求值成数字，与数字列同待遇） */
const NUMERIC: FieldType[] = ["number", "formula", "progress", "rating", "currency"];

/** extra 校验用的运行时清单：新增函数只改这里和 AggregateFn */
export const AGGREGATE_FNS: AggregateFn[] = [
  "count",
  "filled",
  "empty",
  "unique",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "checked",
  "unchecked",
  "share",
];

/** extra 里的字符串能不能当汇总函数用 */
export function isAggregateFn(v: unknown): v is AggregateFn {
  return typeof v === "string" && (AGGREGATE_FNS as string[]).includes(v);
}

/** 字段类型能算哪些汇总（UI 菜单据此列出选项，避免给文本列摆"求和"）。
 *  formula 列展示时求值成数字（调用方传"求值后"的单元格图），因此享受与数字列相同的候选。
 *  share（占比）各类型都有：数字列按和占比，其余列按非空行占比，分母取调用方给的全表范围 */
export function aggregatesForType(type: FieldType): AggregateFn[] {
  if (NUMERIC.includes(type))
    return ["count", "filled", "empty", "unique", "sum", "average", "median", "min", "max", "share"];
  if (type === "checkbox") return ["count", "checked", "unchecked", "share"];
  if (isDateKind(type)) return ["count", "filled", "empty", "unique", "min", "max", "share"];
  return ["count", "filled", "empty", "unique", "share"];
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
  return rowIds.map((id) => cellAt(cells, id, fieldId));
}

/** 非空格计数/取值口径：空串与纯空白也算空（isCellEmpty 已按类型判定，这里只筛掉空值） */
function filledOf(rowIds: string[], fieldId: string, cells: Record<string, Record<string, CellValue>>): CellValue[] {
  return cellValues(rowIds, fieldId, cells).filter((v) => !isCellEmpty(v));
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

/** 升序排序后取中位数：奇数取正中，偶数取中间两数均值 */
function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function numbersOf(values: CellValue[]): number[] {
  return values.map(toNumber).filter((n): n is number => n !== null);
}

/** 占比统一保留 1 位小数；分母为 0 时没有占比可说，返回空串 */
function percentText(part: number, whole: number): string {
  if (!(whole > 0)) return "";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * 汇总值 → 展示文本。rowIds 为空时计数类返回 "0"，取值类返回 ""（无意义不硬凑 0）。
 * "none" 由调用方处理：这里不接受，避免把"没配置"和"配置成无"混为一谈。
 * @param scopeRowIds 占比的分母范围（全表可见行）；省略时占比退化成 100%，只在该范围本身就是全集时传
 */
export function aggregateValue(
  fn: AggregateFn,
  field: DatabaseField,
  rowIds: string[],
  cells: Record<string, Record<string, CellValue>>,
  scopeRowIds?: string[],
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
    case "share": {
      // 数字列按「本范围之和 ÷ 全表之和」，其余列按「本范围非空数 ÷ 全表非空数」
      const scope = scopeRowIds ?? rowIds;
      if (NUMERIC.includes(field.field_type)) {
        const part = numbersOf(filled).reduce((a, b) => a + b, 0);
        const whole = numbersOf(filledOf(scope, field.id, cells)).reduce((a, b) => a + b, 0);
        return percentText(part, whole);
      }
      const whole = scope === rowIds ? filled.length : filledOf(scope, field.id, cells).length;
      return percentText(filled.length, whole);
    }
  }
  if (fn === "sum" || fn === "average" || fn === "median") {
    const nums = numbersOf(filled);
    if (nums.length === 0) return fn === "sum" ? "0" : "";
    if (fn === "median") return formatAsNumber(field, medianOf(nums));
    const total = nums.reduce((a, b) => a + b, 0);
    return formatAsNumber(field, fn === "sum" ? total : total / nums.length);
  }
  // min / max：候选项只给数字列和日期列（见 aggregatesForType）
  if (isDateKind(field.field_type)) {
    const iso = filled.filter((v): v is string => typeof v === "string" && v !== "");
    return formatDateish(field, iso, fn === "min" ? "min" : "max");
  }
  const nums = numbersOf(filled);
  if (nums.length === 0) return "";
  return formatAsNumber(field, fn === "min" ? Math.min(...nums) : Math.max(...nums));
}
