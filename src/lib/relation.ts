import type { CellValue, DatabaseField, DatabaseRow, FieldOptions } from "@/types/database";
import { aggregatesForType, aggregateValue, type AggregateFn } from "./database-aggregate";
import { formatCellValue, parseFieldOptions } from "./database-values";

// 关联（relation）与汇总（rollup）、反向关系（reverse_relation）纯逻辑
// （项目说明书 11 节：求值需单测）。三者都不落库：relation 存对端行 id，
// rollup 每次渲染实时按目标库聚合，reverse_relation 每次渲染实时反查来源行。

/** 关联/汇总求值需要的目标库快照（由 stores/relation.ts 按目标视图缓存） */
export interface RelationDb {
  fields: DatabaseField[];
  rows: DatabaseRow[];
  cells: Record<string, Record<string, CellValue>>;
}

/** relation 字段引用的目标视图 id；未配置返回 null */
export function relationTarget(field: DatabaseField): string | null {
  const opts = parseFieldOptions(field.options);
  return opts.kind === "relation" && opts.target_view_id ? opts.target_view_id : null;
}

/** 关联单元格 → 对端行 id 数组（非法值一律当空关联） */
export function relationRowIds(value: CellValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** 目标库的主字段：可见字段里 position 最小者，没有可见字段时退回全部字段的第一个 */
export function primaryFieldOf(fields: DatabaseField[]): DatabaseField | null {
  const sorted = [...fields].sort((a, b) => a.position - b.position);
  return sorted.find((f) => f.is_hidden === 0) ?? sorted[0] ?? null;
}

/** 行在目标库里的展示文本：主字段 + 其它字段的显示值（选择类自动翻译成选项名） */
export function relationRowText(db: RelationDb, rowId: string): string {
  const rowCells = db.cells[rowId] ?? {};
  return db.fields
    .map((f) => formatCellValue(f.field_type, rowCells[f.id] ?? null, parseFieldOptions(f.options)))
    .filter((s) => s !== "")
    .join(" ");
}

/** 行在目标库里的显示标题（主字段的展示文本）；行已不存在返回 null */
export function relationRowLabel(db: RelationDb, rowId: string): string | null {
  if (!db.rows.some((r) => r.id === rowId)) return null;
  const primary = primaryFieldOf(db.fields);
  if (!primary) return "";
  const value = db.cells[rowId]?.[primary.id] ?? null;
  return formatCellValue(primary.field_type, value, parseFieldOptions(primary.options));
}

/** 关联单元格 → 纯文本（看板卡片、文档内嵌表格等静态只读展示；目标库未加载/行已删时降级显示原始 id） */
export function relationCellText(value: CellValue, db: RelationDb | undefined): string {
  return relationRowIds(value)
    .map((id) => (db ? relationRowLabel(db, id) : null) ?? id)
    .join(", ");
}

/** 关联选择器的候选行：按显示文本模糊匹配，空关键词返回全部（顺序沿用目标库行序） */
export function searchRelationRows(db: RelationDb, query: string): DatabaseRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return db.rows;
  return db.rows.filter((row) => relationRowText(db, row.id).toLowerCase().includes(q));
}

/** rollup 配置解析：关联字段/目标字段任一为空都算未配置（此时列显示为空） */
export function rollupConfig(field: DatabaseField): Extract<FieldOptions, { kind: "rollup" }> | null {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "rollup") return null;
  if (!opts.relation_field_id || !opts.target_field_id) return null;
  return opts;
}

/**
 * 实时计算 rollup 展示值。任一环缺失（未配置、关联字段已删、目标库未加载、目标字段已删）
 * 都返回 null，由调用方展示成空单元格 —— 不把"配置坏了"渲染成 0 或空串误导用户。
 */
export function computeRollup(
  field: DatabaseField,
  rowCells: Record<string, CellValue>,
  fields: DatabaseField[],
  getDb: (viewId: string) => RelationDb | undefined,
): string | null {
  const cfg = rollupConfig(field);
  if (!cfg) return null;
  const relField = fields.find((f) => f.id === cfg.relation_field_id);
  if (!relField) return null;
  const targetViewId = relationTarget(relField);
  if (!targetViewId) return null;
  const db = getDb(targetViewId);
  if (!db) return null;
  const targetField = db.fields.find((f) => f.id === cfg.target_field_id);
  if (!targetField) return null;
  return aggregateValue(cfg.fn, targetField, relationRowIds(rowCells[relField.id] ?? null), db.cells);
}

/** rollup 的聚合函数候选：跟随被汇总字段的类型（数字列才有求和/平均）；字段未知时只给计数 */
export function rollupFnsFor(db: RelationDb | undefined, targetFieldId: string): AggregateFn[] {
  const target = db?.fields.find((f) => f.id === targetFieldId);
  return target ? aggregatesForType(target.field_type) : ["count"];
}

/** 能作为关联目标的布局：这三种布局背后才是数据库三表 */
const DATABASE_LAYOUTS: string[] = ["grid", "board", "calendar"];

/** 可选作关联目标的视图：宿主数据库表（派生视图与文档页排除，它们没有独立的字段/行） */
export function buildRelationPickerFields<T extends { layout: string; source_id?: string | null }>(views: T[]): T[] {
  return views.filter((v) => DATABASE_LAYOUTS.includes(v.layout) && !v.source_id);
}

// ---------- 反向关系（reverse_relation） ----------

/** 反向关系配置解析：来源表 / 来源关联字段任一为空都算未配置（此时列显示为空） */
export function reverseRelationConfig(
  field: DatabaseField,
): Extract<FieldOptions, { kind: "reverse_relation" }> | null {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "reverse_relation") return null;
  if (!opts.source_view_id || !opts.source_field_id) return null;
  return opts;
}

/**
 * 来源表里「指向本表」的关联字段候选：配置反向关系时只能选这种字段，
 * 否则反查方向不对，永远查不到来源行。
 */
export function reverseRelationSourceFields(db: RelationDb | undefined, currentViewId: string | null): DatabaseField[] {
  if (!db || !currentViewId) return [];
  return db.fields.filter((f) => f.field_type === "relation" && relationTarget(f) === currentViewId);
}

/**
 * 实时反查来源行：来源表里所有「关联字段指向本行」的行 id（按来源表行序）。
 * 未配置、来源库未加载、来源字段已删时返回 null（与 rollup 一致：不把配置坏了渲染成空数组误导）。
 */
export function computeReverseRelation(
  rowId: string,
  field: DatabaseField,
  getDb: (viewId: string) => RelationDb | undefined,
): string[] | null {
  const cfg = reverseRelationConfig(field);
  if (!cfg) return null;
  const db = getDb(cfg.source_view_id);
  if (!db) return null;
  const sourceField = db.fields.find((f) => f.id === cfg.source_field_id);
  if (!sourceField) return null;
  return db.rows
    .filter((r) => relationRowIds(db.cells[r.id]?.[sourceField.id] ?? null).includes(rowId))
    .map((r) => r.id);
}
