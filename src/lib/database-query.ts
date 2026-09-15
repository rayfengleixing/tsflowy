import type { CellValue, DatabaseField, DatabaseRow, FieldType, SelectOption } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { formatCellValue, parseFieldOptions } from "./database-values";

// Grid 排序/筛选纯逻辑（项目说明书 11 节：筛选器求值需单测）

export interface SortSpec {
  field_id: string;
  dir: "asc" | "desc";
}

export type FilterOp =
  | "is_empty"
  | "is_not_empty"
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "checked"
  | "unchecked";

export interface FilterSpec {
  id: string;
  field_id: string;
  op: FilterOp;
  /** 比较操作数（按字段类型：text=字符串、number=数字、select=选项id、date=ISO 字符串） */
  value: CellValue;
}

export type FilterMode = "and" | "or";

/** 空值判断：null / undefined / 空串 / 空数组 均视为空 */
export function isCellEmpty(value: CellValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function compareValues(a: CellValue, b: CellValue): number {
  if (isCellEmpty(a) && isCellEmpty(b)) return 0;
  if (isCellEmpty(a)) return 1; // 空值恒排最后
  if (isCellEmpty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.join(",").localeCompare(b.join(","));
  return String(a).localeCompare(String(b));
}

/** 排序：空值恒排最后；asc 小在前，desc 大在前（空值仍最后） */
export function sortRows(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  sorts: SortSpec[],
): DatabaseRow[] {
  if (sorts.length === 0) return rows;
  const out = [...rows];
  out.sort((x, y) => {
    for (const s of sorts) {
      const a = cells[x.id]?.[s.field_id] ?? null;
      const b = cells[y.id]?.[s.field_id] ?? null;
      const aEmpty = isCellEmpty(a);
      const bEmpty = isCellEmpty(b);
      if (aEmpty && bEmpty) continue;
      if (aEmpty) return 1; // 空值最后（无论方向）
      if (bEmpty) return -1;
      const c = compareValues(a, b);
      if (c !== 0) return s.dir === "asc" ? c : -c;
    }
    return 0;
  });
  return out;
}

/**
 * 单条筛选求值。
 * select 字段的 equals 用选项 id；multi_select 的 contains 判断数组是否含选项 id；
 * checkbox 用 checked/unchecked；relation 的 contains 判断数组是否含对端行 id。
 */
export function evaluateFilter(fieldType: FieldType, value: CellValue, op: FilterOp, operand: CellValue): boolean {
  const empty = isCellEmpty(value);
  switch (op) {
    case "is_empty":
      return empty;
    case "is_not_empty":
      return !empty;
    case "checked":
      return fieldType === "checkbox" && value === true;
    case "unchecked":
      return fieldType === "checkbox" && value !== true;
  }
  if (empty) return false; // 需要比较的运算符对空值一律不命中
  switch (op) {
    case "contains": {
      if (fieldType === "multi_select") {
        return Array.isArray(value) && typeof operand === "string" && value.includes(operand);
      }
      if (typeof value === "string") return value.toLowerCase().includes(String(operand ?? "").toLowerCase());
      return false;
    }
    case "not_contains": {
      if (fieldType === "multi_select") {
        return Array.isArray(value) && (!value.includes(String(operand ?? "")) || operand === null);
      }
      if (typeof value === "string") return !value.toLowerCase().includes(String(operand ?? "").toLowerCase());
      return true;
    }
    case "equals":
      return String(value) === String(operand ?? "");
    case "not_equals":
      return String(value) !== String(operand ?? "");
    case "gt":
      return compareValues(value, operand ?? null) > 0;
    case "gte":
      return compareValues(value, operand ?? null) >= 0;
    case "lt":
      return compareValues(value, operand ?? null) < 0;
    case "lte":
      return compareValues(value, operand ?? null) <= 0;
  }
}

/** 多条件组合过滤（AND/OR） */
export function applyFilters(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  filters: FilterSpec[],
  fields: DatabaseField[],
  mode: FilterMode,
): DatabaseRow[] {
  if (filters.length === 0) return rows;
  const fieldMap = new Map(fields.map((f) => [f.id, f]));
  return rows.filter((row) => {
    const results = filters.map((f) => {
      const field = fieldMap.get(f.field_id);
      if (!field) return true;
      return evaluateFilter(field.field_type, cells[row.id]?.[f.field_id] ?? null, f.op, f.value);
    });
    return mode === "and" ? results.every(Boolean) : results.some(Boolean);
  });
}

/** 字段类型支持的比较符（筛选器 UI 用） */
export function opsForType(type: FieldType): FilterOp[] {
  if (type === "checkbox") return ["checked", "unchecked"];
  if (type === "multi_select") return ["is_empty", "is_not_empty", "contains", "not_contains"];
  if (type === "number") return ["is_empty", "is_not_empty", "equals", "not_equals", "gt", "gte", "lt", "lte"];
  if (type === "date" || type === "created_at" || type === "last_edited_at")
    return ["is_empty", "is_not_empty", "equals", "not_equals", "gt", "gte", "lt", "lte"];
  if (type === "single_select") return ["is_empty", "is_not_empty", "equals", "not_equals"];
  return ["is_empty", "is_not_empty", "contains", "not_contains", "equals", "not_equals"];
}

/** 单字段默认筛选操作数（select 取第一个选项 id；date/number 取空由 UI 填） */
export function defaultOperand(field: DatabaseField): CellValue {
  const opts = parseFieldOptions(field.options);
  if (field.field_type === "single_select" && opts.kind === "select" && opts.options.length > 0) {
    return opts.options[0].id;
  }
  if (field.field_type === "multi_select" && opts.kind === "select" && opts.options.length > 0) {
    return opts.options[0].id;
  }
  return null;
}

/** 展示辅助：把字段/选项信息带给排序比较（select 按选项位置排序） */
export function fieldSortKey(field: DatabaseField, value: CellValue): string {
  if (field.field_type === "single_select" && typeof value === "string") {
    const opts = parseFieldOptions(field.options);
    if (opts.kind === "select") {
      const idx = opts.options.findIndex((o) => o.id === value);
      return String(idx === -1 ? 9999 : idx).padStart(5, "0") + value;
    }
  }
  return formatCellValue(field.field_type, value, parseFieldOptions(field.options));
}

export { isReadonlyType };

// ---------- 表格分组（小计与列汇总见 database-aggregate.ts） ----------

/** 空值桶的 key；label 留空由 UI 用 i18n 文案兜底 */
export const UNGROUPED = "__ungrouped__";

export interface GridGroup {
  key: string;
  /** 分组标题（选项名或格式化后的值）；空值桶为空串 */
  label: string;
  rows: DatabaseRow[];
}

/** 复选框只有两个桶没有分组价值，last_edited_at 每行都在变是噪音 —— 都不给分组 */
export function canGroupBy(field: DatabaseField): boolean {
  if (field.field_type === "checkbox" || isReadonlyType(field.field_type)) return false;
  return ["text", "number", "date", "single_select", "multi_select", "url", "phone", "email", "created_at"].includes(
    field.field_type,
  );
}

interface Bucket extends GridGroup {
  optionIndex: number;
  numeric: number | null;
}

function bucketOf(field: DatabaseField, options: SelectOption[], value: CellValue): Bucket {
  // 桶按"显示出来的值"分：created_at 因此按天聚拢，格式相同的两个数字同属一桶
  const label = formatCellValue(field.field_type, value, parseFieldOptions(field.options));
  const base = { label, rows: [] as DatabaseRow[], optionIndex: 0, numeric: null as number | null };
  if (field.field_type === "single_select" && typeof value === "string") {
    const idx = options.findIndex((o) => o.id === value);
    // 选项被删掉后残留的值自成一组，排在已知选项之后、未分组之前
    return {
      ...base,
      key: value,
      label: idx === -1 ? value : options[idx].name,
      optionIndex: idx === -1 ? options.length : idx,
    };
  }
  if (field.field_type === "multi_select" && Array.isArray(value)) {
    // 一行的多个选项合成一个桶（按选项定义顺序），保证一行只被计一次
    const known = options.filter((o) => value.includes(o.id));
    const rest = value.filter((id) => !options.some((o) => o.id === id));
    const ids = [...known.map((o) => o.id), ...rest];
    const names = [...known.map((o) => o.name), ...rest];
    return { ...base, key: ids.join("|"), label: names.join(", "), optionIndex: known.length ? 0 : options.length };
  }
  const n = typeof value === "number" ? value : Number(value);
  return { ...base, key: label, numeric: Number.isFinite(n) ? n : null };
}

/**
 * 按字段把行分桶。桶内顺序沿用传入顺序（视图排序已生效），
 * 桶顺序：单选/多选按选项定义顺序 → 数字按大小 / 日期按时间 → 文本字典序，空值桶恒最后。
 */
export function groupRowsForGrid(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  field: DatabaseField,
): GridGroup[] {
  const parsed = parseFieldOptions(field.options);
  const options = parsed.kind === "select" ? parsed.options : [];
  const buckets = new Map<string, Bucket>();
  const ungrouped: DatabaseRow[] = [];
  for (const row of rows) {
    const value = cells[row.id]?.[field.id] ?? null;
    if (isCellEmpty(value)) {
      ungrouped.push(row);
      continue;
    }
    const computed = bucketOf(field, options, value);
    let bucket = buckets.get(computed.key);
    if (!bucket) {
      bucket = computed;
      buckets.set(computed.key, bucket);
    }
    bucket.rows.push(row);
  }
  const groups: GridGroup[] = [...buckets.values()]
    .sort((a, b) => {
      if (a.optionIndex !== b.optionIndex) return a.optionIndex - b.optionIndex;
      if (a.numeric !== null && b.numeric !== null) return a.numeric - b.numeric;
      return a.label.localeCompare(b.label);
    })
    .map(({ key, label, rows: grouped }) => ({ key, label, rows: grouped }));
  if (ungrouped.length > 0) groups.push({ key: UNGROUPED, label: "", rows: ungrouped });
  return groups;
}
