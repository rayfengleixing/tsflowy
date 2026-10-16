import type { CellValue, DatabaseField } from "@/types/database";
import { cellAt, defaultOperand, evaluateFilter, isFilterOp, opsForType, type FilterOp } from "./database-query";

// 条件格式：满足条件时给单元格或整行上色。
// 条件本身复用筛选的比较符语义（evaluateFilter），所以「文本包含」「数字 >」这些口径与筛选完全一致；
// 但只看当前行——拿不到「本列平均」「上一行」这类跨行量（见 README 已知限制的取舍说明）。

export type CondTone = "gray" | "green" | "yellow" | "orange" | "red" | "blue" | "purple";
export type CondScope = "cell" | "row";

export interface CondFormatRule {
  id: string;
  /** 判定字段，也是 scope=cell 时被上色的列 */
  field_id: string;
  op: FilterOp;
  /** 比较操作数，与筛选同形（is_empty / checked 这类不需要值时为 null） */
  value: CellValue;
  tone: CondTone;
  scope: CondScope;
}

/** 单表规则上限：够铺常用配色，又不至于让每格的判定变成线性长循环 */
export const MAX_COND_RULES = 20;

export const COND_TONES: CondTone[] = ["gray", "green", "yellow", "orange", "red", "blue", "purple"];
export const COND_SCOPES: CondScope[] = ["cell", "row"];

/** 规则编辑器里的色点 */
export const COND_TONE_DOT: Record<CondTone, string> = {
  gray: "bg-neutral-300",
  green: "bg-green-500",
  yellow: "bg-yellow-400",
  orange: "bg-orange-500",
  red: "bg-red-500",
  blue: "bg-brand-500",
  purple: "bg-purple-500",
};

/** 命中后的单元格底色（整行上色时同一套类铺到每个 td，含冻结列，避免 sticky 背景盖掉） */
export const COND_TONE_CELL: Record<CondTone, string> = {
  gray: "bg-neutral-100 text-neutral-600 dark:bg-neutral-700/40 dark:text-neutral-300",
  green: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  yellow: "bg-yellow-50 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-300",
  orange: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400",
  red: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  blue: "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-500",
  purple: "bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400",
};

export function isCondTone(v: unknown): v is CondTone {
  return typeof v === "string" && (COND_TONES as string[]).includes(v);
}

export function isCondScope(v: unknown): v is CondScope {
  return typeof v === "string" && (COND_SCOPES as string[]).includes(v);
}

/** 索引键：fieldId 传空串即「整行」这一档 */
export const condKey = (rowId: string, fieldId: string): string => `${rowId}\u0000${fieldId}`;

/** 新建规则：比较符与操作数取该字段筛选的默认值，保证一条新规则一落地就是可判定的 */
export function newCondRule(id: string, field: DatabaseField): CondFormatRule {
  // 新规则默认标红：最常见的诉求就是「这一列满足某条件时提醒我」
  return {
    id,
    field_id: field.id,
    op: opsForType(field.field_type)[0],
    value: defaultOperand(field),
    tone: "red",
    scope: "cell",
  };
}

/** extra 里的数组 → 合法规则；缺字段/未知比较符/未知颜色直接丢，不做「猜一个默认」 */
export function parseCondFormats(v: unknown): CondFormatRule[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CondFormatRule[] = [];
  for (const raw of v) {
    if (out.length >= MAX_COND_RULES) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || typeof o.field_id !== "string" || !o.field_id) continue;
    if (!isFilterOp(o.op)) continue;
    if (!isCondTone(o.tone) || !isCondScope(o.scope)) continue;
    out.push({
      id: o.id,
      field_id: o.field_id,
      op: o.op,
      value: (o.value ?? null) as CellValue,
      tone: o.tone,
      scope: o.scope,
    });
  }
  return out;
}

/** 判定一屏行：返回 rowId+fieldId → 颜色 的索引，渲染时 O(1) 查。
 *  同一档（单元格 / 整行）按规则顺序先到先得；同列上单元格规则优先于整行规则（更具体）。
 *  字段被删、或字段类型改了导致比较符不再适用（数字列的「包含」）时，该规则静默失效。 */
export function buildCondIndex(
  rules: CondFormatRule[],
  rowIds: string[],
  cells: Record<string, Record<string, CellValue>>,
  fields: DatabaseField[],
): Map<string, CondTone> {
  const index = new Map<string, CondTone>();
  if (rules.length === 0 || rowIds.length === 0) return index;
  for (const rule of rules) {
    const field = fields.find((f) => f.id === rule.field_id);
    if (!field) continue;
    if (!opsForType(field.field_type).includes(rule.op)) continue;
    for (const rowId of rowIds) {
      const key = condKey(rowId, rule.scope === "row" ? "" : rule.field_id);
      if (index.has(key)) continue;
      const value = cellAt(cells, rowId, rule.field_id);
      if (evaluateFilter(field.field_type, value, rule.op, rule.value)) index.set(key, rule.tone);
    }
  }
  return index;
}

/** 渲染取色：先看该列的单元格规则，再回落到整行规则 */
export function toneOfIndex(index: Map<string, CondTone>, rowId: string, fieldId: string): CondTone | null {
  return index.get(condKey(rowId, fieldId)) ?? index.get(condKey(rowId, "")) ?? null;
}
