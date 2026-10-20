// GridView 的视图模型（MVVM 的 VM 层）。
// 分工：这里只写「状态怎么算、命令按什么顺序发」，不碰 React、不碰 zustand、不弹提示；
// 副作用（写库、toast、日志、setState）由适配层 use-grid-view-model.ts 注入。
// 本仓库的 vitest 默认是 node 环境（组件测要按文件单独开 jsdom），整套表格交互测起来代价大，
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
  groupRowsNested,
  sortRows,
  type FilterMode,
  type FilterNode,
  type GridGroupNode,
  type SortSpec,
} from "@/lib/database-query";
import { t } from "@/lib/i18n";
import { hierarchyLines, parentCandidates } from "@/lib/database-hierarchy";
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
  filters: FilterNode[];
  filterMode: FilterMode;
  sorts: SortSpec[];
  /** 分组字段 id，按层级顺序（最多三层）；字段被删或类型改成不可分组时该层自动跳过 */
  groupFieldIds: string[];
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
  /** 生效的分组字段（层级顺序）；空数组即不分组 */
  groupFields: DatabaseField[];
  groupableFields: DatabaseField[];
  groups: GridGroupNode[] | null;
}

/** 叠在 core 之上的纯交互状态 */
export interface GridUiInput {
  checkedRows: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  /** 折叠的父行 id（只在未分组时生效，分组模式由 collapsedGroups 管） */
  collapsedRows: ReadonlySet<string>;
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
  const { fields, rows, cells, sortableCells, filters, filterMode, sorts, groupFieldIds } = input;
  const visibleFields = fields.filter((f) => f.is_hidden === 0);
  const displayRows = sortRows(applyFilters(rows, sortableCells, filters, fields, filterMode), sortableCells, sorts);
  // 分组字段被删除或改成不可分组的类型时逐层剔除（配置留着，改回来还在）
  const groupFields = groupFieldIds
    .map((id) => fields.find((f) => f.id === id))
    .filter((f): f is DatabaseField => !!f && canGroupBy(f));
  return {
    visibleFields,
    primaryField: visibleFields.length > 0 ? visibleFields[0] : null,
    displayRows,
    displayRowIds: displayRows.map((r) => r.id),
    groupFields,
    groupableFields: visibleFields.filter(canGroupBy),
    groups: groupFields.length > 0 ? groupRowsNested(displayRows, cells, groupFields) : null,
  };
}

/**
 * 组树摊平成线性条目：组头 →（未折叠时）下层组或数据行 → 该组小计。
 * 折叠键用组的 path（同名桶落在不同父组里是两个组），小计按整棵子树的行算，
 * 所以父组小计天然等于其下层各行之和，不必再逐层汇总。
 */
function flattenGroupLines(
  nodes: GridGroupNode[],
  collapsedGroups: ReadonlySet<string>,
  hasAggregates: boolean,
): GridFlatLine[] {
  const out: GridFlatLine[] = [];
  for (const g of nodes) {
    const collapsed = collapsedGroups.has(g.path);
    out.push({
      kind: "header",
      key: g.path,
      depth: g.depth,
      label: g.key === UNGROUPED || !g.label ? t("grid.ungrouped") : g.label,
      count: g.rows.length,
      collapsed,
    });
    if (collapsed) continue;
    if (g.subgroups.length > 0) out.push(...flattenGroupLines(g.subgroups, collapsedGroups, hasAggregates));
    else for (const row of g.rows) out.push({ kind: "row", row });
    if (hasAggregates) out.push({ kind: "subtotal", key: g.path, rowIds: g.rows.map((r) => r.id) });
  }
  return out;
}

export function deriveGridModel(core: GridCore, ui: GridUiInput): GridModel {
  const { checkedRows, collapsedGroups, collapsedRows, aggregates } = ui;
  const { visibleFields, displayRows, groups } = core;
  const selectedIds = displayRows.filter((r) => checkedRows.has(r.id)).map((r) => r.id);
  const aggregateOf = (field: DatabaseField) => normalizeAggregate(field.field_type, aggregates[field.id]);
  const hasAggregates = visibleFields.some((f) => aggregateOf(f));

  const flatLines: GridFlatLine[] = groups
    ? flattenGroupLines(groups, collapsedGroups, hasAggregates)
    : hierarchyFlatLines(displayRows, collapsedRows);

  return {
    ...core,
    selectedIds,
    allSelected: displayRows.length > 0 && selectedIds.length === displayRows.length,
    hasAggregates,
    aggregateOf,
    flatLines,
    // 折叠状态一变就要重新定位命中行；层级模式折的是行，分组模式折的是组
    collapsedKey: groups ? [...collapsedGroups].join("|") : [...collapsedRows].sort().join("|"),
  };
}

/**
 * 未分组时把父子行层级摊平成显示行序（父行紧跟它的子行，兄弟行沿用筛选/排序后的行序）。
 * 一张表没有任何父子关系时原样返回，渲染路径与层级改造之前逐字节一致。
 */
function hierarchyFlatLines(rows: DatabaseRow[], collapsedRows: ReadonlySet<string>): GridFlatLine[] {
  if (!rows.some((r) => r.parent_id != null)) return rows.map((row) => ({ kind: "row", row }));
  return hierarchyLines(rows, collapsedRows).map((l) => ({
    kind: "row",
    row: l.row,
    depth: l.depth,
    hasChildren: l.hasChildren,
    collapsed: l.collapsed,
  }));
}

/** 命中行在各层组里的 path 链（顶层→叶子）：搜索定位要按这条链逐层展开折叠 */
export function groupPathOfRow(nodes: GridGroupNode[], rowId: string): string[] {
  for (const g of nodes) {
    if (g.subgroups.length > 0) {
      const inner = groupPathOfRow(g.subgroups, rowId);
      if (inner.length > 0) return [g.path, ...inner];
    } else if (g.rows.some((r) => r.id === rowId)) {
      return [g.path];
    }
  }
  return [];
}

/**
 * 命中行在层级模式里被折叠掉的祖先行 id（顶层→自身父行）。
 * 只解最近一层仍会让它藏在折叠的祖父行下面，所以整条链一次展开。
 */
export function collapsedAncestorsOfRow(
  rows: DatabaseRow[],
  collapsedRows: ReadonlySet<string>,
  rowId: string,
): string[] {
  const line = hierarchyLines(rows).find((l) => l.row.id === rowId);
  if (!line) return [];
  return line.ancestors.filter((id) => collapsedRows.has(id));
}

/** 拖拽落点的两种意图：按行序改位置，或（按住 Alt）把拖动行挂到目标行下 */
export type RowDropMode = "move" | "nest";

export type RowDropPlan =
  { kind: "reorder"; ids: string[] } | { kind: "reparent"; rowId: string; parentId: string } | null;

/**
 * 拖拽落点 → 要发的命令。
 * nest 只在目标行是合法父行时成立（不能挂到自己或自己后代下、子树也不能超深，同一套判定见
 * lib/database-hierarchy 的 parentCandidates）；挂不成就回落成改位置，拖错了不该什么都不发生。
 * reorder 传的是 store 顺序的全量行序（= position 顺序），传筛选后的行序会把被筛掉的行从库里剔掉。
 */
export function planRowDrop(p: {
  rows: DatabaseRow[];
  draggingId: string;
  targetId: string;
  mode: RowDropMode;
}): RowDropPlan {
  const ids = p.rows.map((r) => r.id);
  const from = ids.indexOf(p.draggingId);
  const to = ids.indexOf(p.targetId);
  if (from < 0 || to < 0 || p.draggingId === p.targetId) return null;
  if (p.mode === "nest" && parentCandidates(p.rows, p.draggingId).some((r) => r.id === p.targetId)) {
    return { kind: "reparent", rowId: p.draggingId, parentId: p.targetId };
  }
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  return { kind: "reorder", ids };
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
