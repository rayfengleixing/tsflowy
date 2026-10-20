import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { computeRowFormulas, referencedFieldNames } from "@/lib/database-formula";
import { FIELD_KINDS, isComputedKind } from "@/lib/field-kinds";
import { formatCellValue, parseFieldOptions, sparseGet } from "@/lib/database-values";
import {
  computeReverseRelation,
  computeRollup,
  relationCellText,
  relationTarget,
  reverseRelationConfig,
  type RelationDb,
} from "@/lib/relation";

// 计算列求值的共享入口（原在 features/database/grid-view-helpers.ts，Grid 专用）：
// Board/Calendar/Timeline 与 Grid 的筛选/排序都读这里的 sortable 图，行为一致。

/** 存 id、公式里要换成文本的列：选择类（选项 id → 选项名）与关联（行 id → 对端标题）。
 *  数字/日期等一律原样交给公式——转成展示串就没法参与算术了。 */
function isIdBearingField(f: DatabaseField): boolean {
  return f.field_type === "relation" || FIELD_KINDS[f.field_type].optionBearing;
}

function formulaReadableValue(
  f: DatabaseField,
  value: CellValue,
  relationDbOf: (viewId: string) => RelationDb | undefined,
): CellValue {
  if (f.field_type === "relation") return relationCellText(value, relationDbOf(relationTarget(f) ?? ""));
  const text = formatCellValue(f.field_type, value, parseFieldOptions(f.options));
  return text === "" ? null : text;
}

/**
 * 公式/汇总/反向关系字段没有存储值：把求值结果提前算进一份"有效单元格"图，排序/筛选/列汇总/分组小计都读它，
 * 否则按这些列排序排不动（raw 恒为空值）、筛选恒不命中（raw 值永远是空）、汇总恒为空。没有这类字段时直接复用原始 cells。
 *
 * 一次遍历产出两份图：
 * - sortable：数值样式的汇总值转成 number（"9.00" 不会按字典序排在 "42.50" 之后），供排序/筛选/聚合；
 * - display：保留展示文本（rollup 带精度/货币格式），供网格单元格直读——行渲染不再逐格重算。
 *
 * 公式取数走第三份视野（formulaView）：计算列要先铺进来，选择/关联列要换成文本，
 * 否则 {汇总列} 恒为空、{状态} 是 opt_ab12、{关联项目} 是一串 UUID——整条公式静默失效或拼出乱码。
 */
export function computeEvaluatedCells(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  fields: DatabaseField[],
  relationDbOf: (viewId: string) => RelationDb | undefined,
): { sortable: Record<string, Record<string, CellValue>>; display: Record<string, Record<string, CellValue>> } {
  const hasComputed = fields.some((f) => isComputedKind(f.field_type));
  if (!hasComputed) return { sortable: cells, display: cells };
  const hasFormula = fields.some((f) => f.field_type === "formula");
  // 只有被公式点名的列才值得多算一次（每行都翻标题/选项名，大表渲染白付一遍钱）
  const refs = hasFormula ? referencedFieldNames(fields) : null;
  const sortable: Record<string, Record<string, CellValue>> = {};
  const display: Record<string, Record<string, CellValue>> = {};
  for (const row of rows) {
    const rowCells = cells[row.id] ?? {};
    let sortCopy: Record<string, CellValue> | null = null;
    let displayCopy: Record<string, CellValue> | null = null;
    let formulaView: Record<string, CellValue> | null = null;
    for (const f of fields) {
      if (f.field_type === "rollup") {
        const v = computeRollup(f, rowCells, fields, relationDbOf);
        if (v === null) continue;
        const n = Number(v);
        const numish = v.trim() !== "" && Number.isFinite(n) ? n : v;
        (sortCopy ??= { ...rowCells })[f.id] = numish;
        (displayCopy ??= { ...rowCells })[f.id] = v;
        if (refs?.has(f.name)) (formulaView ??= { ...rowCells })[f.id] = numish;
      } else if (f.field_type === "reverse_relation") {
        // 反向关系：实时反查来源行，值为来源行 id 数组（可参与排序/汇总）
        const v = computeReverseRelation(row.id, f, relationDbOf);
        if (v === null) continue;
        (sortCopy ??= { ...rowCells })[f.id] = v;
        (displayCopy ??= { ...rowCells })[f.id] = v;
        if (refs?.has(f.name)) {
          const cfg = reverseRelationConfig(f);
          const sourceDb = cfg ? relationDbOf(cfg.source_view_id) : undefined;
          (formulaView ??= { ...rowCells })[f.id] = relationCellText(v, sourceDb);
        }
      } else if (refs && isIdBearingField(f) && refs.has(f.name)) {
        const stored = rowCells[f.id] ?? null;
        const shown = formulaReadableValue(f, stored, relationDbOf);
        // 与存储值一致就不必另开一份视野（纯文本关联降级时正是这种情况）
        if (shown !== stored) (formulaView ??= { ...rowCells })[f.id] = shown;
      }
    }
    // 每行一次建图：公式串公式按依赖序取计算值，环成员得 #CYCLE
    const formulaValues = hasFormula ? computeRowFormulas(formulaView ?? rowCells, fields) : null;
    if (formulaValues) {
      for (const f of fields) {
        if (f.field_type !== "formula") continue;
        const v = formulaValues.get(f.id) ?? null;
        if (v === null) continue;
        (sortCopy ??= { ...rowCells })[f.id] = v;
        (displayCopy ??= { ...rowCells })[f.id] = v;
      }
    }
    sortable[row.id] = sortCopy ?? rowCells;
    display[row.id] = displayCopy ?? rowCells;
  }
  return { sortable, display };
}

/**
 * 单行有效单元格：先取求值图（含公式/汇总/反向关系），没有条目再回落到存储图。
 * 各视图渲染一行都要这一步，散着写就成了四份 `sparseGet(..) ?? sparseGet(..) ?? {}`。
 */
export function rowCellsOf(
  evaluated: Record<string, Record<string, CellValue>>,
  cells: Record<string, Record<string, CellValue>>,
  rowId: string,
): Record<string, CellValue> {
  return sparseGet(evaluated, rowId) ?? sparseGet(cells, rowId) ?? {};
}
