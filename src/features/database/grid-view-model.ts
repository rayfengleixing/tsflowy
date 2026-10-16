// GridView 的视图模型（MVVM 的 VM 层）。
// 分工：这里只写「状态怎么算、命令按什么顺序发」，不碰 React、不碰 zustand、不弹提示；
// 副作用（写库、toast、日志、setState）由适配层 use-grid-view-model.ts 注入。
// 本仓库的 vitest 是 node 环境（没有 jsdom / testing-library），组件测不了，
// 所以要把可验证的规则收到这一层。
//
// 派生刻意分两段，为了守住与改造前一致的 memo 边界：
//   deriveGridCore  只跟数据/筛选/排序/分组字段走（排序与分组是 O(n log n)，勾一行不该重算）；
//   deriveGridModel 再叠上纯交互状态（勾选、折叠、列汇总），只做线性遍历。
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { normalizeAggregate, type AggregateFn } from "@/lib/database-aggregate";
import {
  UNGROUPED,
  applyFilters,
  canGroupBy,
  groupRowsForGrid,
  sortRows,
  type FilterMode,
  type FilterSpec,
  type GridGroup,
  type SortSpec,
} from "@/lib/database-query";
import { t } from "@/lib/i18n";
import type { GridFlatLine } from "./grid-view-helpers";

/** rowId → fieldId → 单元格值 */
export type CellGraph = Record<string, Record<string, CellValue>>;

/** 算出「有哪些行列、按什么顺序」所需的数据输入 */
export interface GridDataInput {
  fields: DatabaseField[];
  rows: DatabaseRow[];
  /** 存储的原始单元格：分组按它取格值（与改造前一致，不换成求值图） */
  cells: CellGraph;
  /** 计算列求值后的可排序图：筛选与排序读它，否则按公式/汇总列筛选恒不命中 */
  sortableCells: CellGraph;
  filters: FilterSpec[];
  filterMode: FilterMode;
  sorts: SortSpec[];
  /** 分组字段 id；字段被删或类型改成不可分组时按不分组处理 */
  groupFieldId: string | null;
}

/** 只随数据与视图配置变化的派生结果 */
export interface GridCore {
  visibleFields: DatabaseField[];
  /** 名称列（主列）：第一个可见列，作为行详情入口 */
  primaryField: DatabaseField | null;
  /** 筛选 + 排序后的行 */
  displayRows: DatabaseRow[];
  /** 稳定引用给底部汇总菜单用（每次渲染新建会让它的 useMemo 全失效） */
  displayRowIds: string[];
  groupField: DatabaseField | null;
  groupableFields: DatabaseField[];
  groups: GridGroup[] | null;
}

/** 叠在 core 之上的纯交互状态 */
export interface GridUiInput {
  checkedRows: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  aggregates: Record<string, AggregateFn | undefined>;
}

/** 渲染一屏所需的全部派生状态 */
export interface GridModel extends GridCore {
  /** 勾选中且仍在当前可见集合里的行 id */
  selectedIds: string[];
  allSelected: boolean;
  hasAggregates: boolean;
  /** 字段类型可能已变：历史选择不在候选里就回落成计数（写成属性，解构出来调用不会丢 this） */
  aggregateOf: (field: DatabaseField) => AggregateFn | undefined;
  /** 分组模式摊平成线性条目（组头 / 数据行 / 组小计），窗口化与非分组共用一套序号 */
  flatLines: GridFlatLine[];
  /** 搜索命中定位用的折叠键：折叠状态一变就作 revision 重新定位 */
  collapsedKey: string;
}

export function deriveGridCore(input: GridDataInput): GridCore {
  const { fields, rows, cells, sortableCells, filters, filterMode, sorts, groupFieldId } = input;
  const visibleFields = fields.filter((f) => f.is_hidden === 0);
  const displayRows = sortRows(applyFilters(rows, sortableCells, filters, fields, filterMode), sortableCells, sorts);
  // 分组字段被删除或改成不可分组的类型时，自动回落成不分组（配置留着，改回来还在）
  const groupField = fields.find((f) => f.id === groupFieldId && canGroupBy(f)) ?? null;
  return {
    visibleFields,
    primaryField: visibleFields.length > 0 ? visibleFields[0] : null,
    displayRows,
    displayRowIds: displayRows.map((r) => r.id),
    groupField,
    groupableFields: visibleFields.filter(canGroupBy),
    groups: groupField ? groupRowsForGrid(displayRows, cells, groupField) : null,
  };
}

export function deriveGridModel(core: GridCore, ui: GridUiInput): GridModel {
  const { checkedRows, collapsedGroups, aggregates } = ui;
  const { visibleFields, displayRows, groups } = core;
  const selectedIds = displayRows.filter((r) => checkedRows.has(r.id)).map((r) => r.id);
  const aggregateOf = (field: DatabaseField) => normalizeAggregate(field.field_type, aggregates[field.id]);
  const hasAggregates = visibleFields.some((f) => aggregateOf(f));

  const flatLines: GridFlatLine[] = groups
    ? groups.flatMap((g) => {
        const collapsed = collapsedGroups.has(g.key);
        const head: GridFlatLine = {
          kind: "header",
          key: g.key,
          label: g.key === UNGROUPED || !g.label ? t("grid.ungrouped") : g.label,
          count: g.rows.length,
          collapsed,
        };
        if (collapsed) return [head];
        const body: GridFlatLine[] = g.rows.map((row) => ({ kind: "row", row }));
        const subtotal: GridFlatLine[] = hasAggregates
          ? [{ kind: "subtotal", key: g.key, rowIds: g.rows.map((r) => r.id) }]
          : [];
        return [head, ...body, ...subtotal];
      })
    : displayRows.map((row) => ({ kind: "row", row }));

  return {
    ...core,
    selectedIds,
    allSelected: displayRows.length > 0 && selectedIds.length === displayRows.length,
    hasAggregates,
    aggregateOf,
    flatLines,
    collapsedKey: groups ? [...collapsedGroups].join("|") : "",
  };
}

/** 勾选单行：在原集合上增删一个行 id（返回新集合，React 状态不可原地改） */
export function toggleRowChecked(prev: ReadonlySet<string>, rowId: string): Set<string> {
  const next = new Set(prev);
  if (next.has(rowId)) next.delete(rowId);
  else next.add(rowId);
  return next;
}

/** 全选/取消全选：已全选则清空，否则收当前可见的全部行（忽略原集合，与改造前一致） */
export function toggleAllRowsChecked(displayRows: DatabaseRow[], allSelected: boolean): Set<string> {
  return allSelected ? new Set<string>() : new Set(displayRows.map((r) => r.id));
}

/** 批量行命令的副作用入口（由适配层接 store / toast / logger） */
export interface BulkRowEffects {
  removeRows(ids: string[]): Promise<number>;
  duplicateRows(ids: string[]): Promise<unknown[]>;
  /** 命令成功后清空勾选 */
  clearChecked(): void;
  toast: { success(message: string): void; error(message: string): void };
  log(message: string, err: unknown): void;
}

/** 删除选中行 = 移入本表回收站（可在「回收站」里恢复），调用方仍要先确认。空集合直接不发命令。 */
export async function deleteCheckedRows(ids: string[], fx: BulkRowEffects): Promise<void> {
  if (ids.length === 0) return;
  try {
    const n = await fx.removeRows(ids);
    fx.clearChecked();
    fx.toast.success(t("row.deletedMany", { count: String(n) }));
  } catch (e) {
    fx.log("delete rows failed", e);
    fx.toast.error(t("error.db", { message: String(e) }));
  }
}

/** 复制选中行（含单元格），成功后同样清空勾选 */
export async function duplicateCheckedRows(ids: string[], fx: BulkRowEffects): Promise<void> {
  if (ids.length === 0) return;
  try {
    const created = await fx.duplicateRows(ids);
    fx.clearChecked();
    fx.toast.success(t("row.duplicated", { count: String(created.length) }));
  } catch (e) {
    fx.log("duplicate rows failed", e);
    fx.toast.error(t("error.db", { message: String(e) }));
  }
}
