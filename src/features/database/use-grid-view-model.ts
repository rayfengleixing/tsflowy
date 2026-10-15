// GridView 的适配层（MVVM 的 V↔VM 接线）：把 store、React 状态与副作用接到纯视图模型上。
// 这里只负责「数据从哪来、命令往哪去」，规则本身都在 grid-view-model.ts。
import { useMemo } from "react";
import { toast } from "sonner";
import { useDbStore } from "@/stores/database-context";
import { computeEvaluatedCells } from "@/lib/database-evaluated-cells";
import { logger } from "@/lib/logger";
import type { AggregateFn } from "@/lib/database-aggregate";
import {
  deriveGridCore,
  deriveGridModel,
  deleteCheckedRows,
  duplicateCheckedRows,
  type BulkRowEffects,
  type CellGraph,
  type GridModel,
} from "./grid-view-model";
import { useRelationDbs } from "./use-database-data";
import type { RelationDb } from "@/lib/relation";

export interface GridViewLocalState {
  groupFieldId: string | null;
  collapsedGroups: ReadonlySet<string>;
  checkedRows: ReadonlySet<string>;
  aggregates: Record<string, AggregateFn | undefined>;
  /** 批量命令成功后清空勾选（本地 React 状态的 setter） */
  setCheckedRows: (next: Set<string>) => void;
}

export interface UseGridViewModelResult {
  model: GridModel;
  /** 求值后的展示图：行渲染与 CSV 导出读它（rollup 保留展示格式） */
  displayCells: CellGraph;
  /** 求值后的可排序图：筛选/排序/汇总按它取值 */
  sortableCells: CellGraph;
  relationDbOf: (viewId: string) => RelationDb | undefined;
  /** 批量删/复选中行：命令对象按当前可见的勾选行发出，成功后清空勾选 */
  runDeleteCheckedRows: () => Promise<void>;
  runDuplicateCheckedRows: () => Promise<void>;
}

/** 订阅数据库 store + 本地视图状态，产出算好的 GridModel 与批量行命令 */
export function useGridViewModel(state: GridViewLocalState): UseGridViewModelResult {
  const store = useDbStore();
  const { fields, rows, cells, sorts, filters, filterMode } = store;

  const relationDbOf = useRelationDbs(fields);

  // 公式/汇总字段没有存储值：求值一次，渲染与筛选/排序共用同一张图
  const evaluated = useMemo(
    () => computeEvaluatedCells(rows, cells, fields, relationDbOf),
    [rows, cells, fields, relationDbOf],
  );
  const sortableCells = evaluated.sortable;
  const displayCells = evaluated.display;

  const core = useMemo(
    () =>
      deriveGridCore({
        fields,
        rows,
        cells,
        sortableCells,
        filters,
        filterMode,
        sorts,
        groupFieldId: state.groupFieldId,
      }),
    [fields, rows, cells, sortableCells, filters, filterMode, sorts, state.groupFieldId],
  );

  // 勾选/折叠/列汇总只走线性遍历：排序与分组留在 core 里，勾一行不会重算一遍
  const model = useMemo(
    () =>
      deriveGridModel(core, {
        checkedRows: state.checkedRows,
        collapsedGroups: state.collapsedGroups,
        aggregates: state.aggregates,
      }),
    [core, state.checkedRows, state.collapsedGroups, state.aggregates],
  );

  const effects: BulkRowEffects = {
    removeRows: store.removeRows,
    duplicateRows: store.duplicateRows,
    clearChecked: () => state.setCheckedRows(new Set<string>()),
    toast,
    log: (message, err) => logger.error(message, err),
  };

  return {
    model,
    displayCells,
    sortableCells,
    relationDbOf,
    runDeleteCheckedRows: () => deleteCheckedRows(model.selectedIds, effects),
    runDuplicateCheckedRows: () => duplicateCheckedRows(model.selectedIds, effects),
  };
}
