import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Copy, Download, FileUp, FileSpreadsheet, SquarePen, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDbStore, useDbStoreApi } from "@/stores/database-context";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { MAX_GROUP_DEPTH, cellAt } from "@/lib/database-query";
import type { AggregateFn } from "@/lib/database-aggregate";
import { CsvImportDialog } from "./CsvImportDialog";
import { RowTrashDialog } from "./RowTrashDialog";
import { RowParentDialog } from "./RowParentDialog";
import { BulkEditDialog } from "./BulkEditDialog";
import { CondFormatButton, CondFormatDialogHost, useCondFormat } from "./cond-format-bar";
import { useGridViewModel } from "./use-grid-view-model";
import {
  collapsedAncestorsOfRow,
  groupPathOfRow,
  planRowDrop,
  toggleRowChecked as updateRowChecked,
  toggleAllRowsChecked as updateAllRowsChecked,
  type RowDropMode,
} from "./grid-view-model";
import { hierarchyLines, parentCandidates } from "@/lib/database-hierarchy";
import { FieldOptionsEditor } from "./FieldOptionsEditor";
import { QueryButtons, QueryPanels, useQueryBar } from "./query-bar";
import { AggregateMenu } from "./AggregateMenu";
import { useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import { HiddenColumnsMenu } from "./grid-parts";
import { renderGridRow, type GridRowContext, type GridRowHierarchy } from "./grid-row";
import { GridAddRow, GridGroupHeaderRow, GridSpacerRow, GridSubtotalRow } from "./grid-rows";
import { createGridIoSlice, type GridImportPlan } from "./grid-io-slice";
import { GridHeaderRow } from "./GridHeaderRow";
import {
  GROUP_LINE_H_FALLBACK,
  ROW_H_FALLBACK,
  VIRTUAL_MIN_ROWS,
  VIRTUAL_OVERSCAN,
  cellSelector,
  computeVirtualWindow,
  computeWindowFromHeights,
  lineHeightsOf,
  offsetOfHeights,
  type GridFlatLine,
} from "./grid-view-helpers";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";

import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import type { View } from "@/types/models";

/** Grid 数据库视图（说明书 10-M4）：表头 32px / 行 32px / 单元格聚焦蓝框（6.6 节） */
export function GridView({
  view,
  source,
  tabs,
}: {
  /** 当前视图：显示配置与数据的归属键（可能是宿主本身，也可能是派生视图） */
  view: View;
  /** 宿主页面：标题、重命名与行详情的父子归属都挂在它上面 */
  source: View;
  /** 顶栏左侧的视图标签栏（页内切换 grid/board/calendar） */
  tabs?: React.ReactNode;
}) {
  const store = useDbStore();
  const storeApi = useDbStoreApi();
  const load = useDbStore((s) => s.load);
  const { fields, rows, cells, loading, rowDetail } = store;
  const { closeRowDetail } = store;

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [optionsEditorFor, setOptionsEditorFor] = useState<DatabaseField | null>(null);
  const bar = useQueryBar();
  // 待确认删除的行（删行=进回收站，确认后仍可在「回收站」里恢复）
  const [deleteRowTarget, setDeleteRowTarget] = useState<DatabaseRow | null>(null);
  const [rowTrashOpen, setRowTrashOpen] = useState(false);
  // 多选行（序号列勾选框）：键为 rowId；实际生效集合每次按可见行求交，行被删/被筛走都不会残留
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  // 批量改值弹窗：勾选行 + 一个字段一次改完
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [groupFieldIds, setGroupFieldIds] = useState<string[]>(() => readViewConfig(view).groupFieldIds ?? []);
  // 键盘光标（↑↓←→/Tab 移动、Enter 编辑、Delete 清空、Esc 退出）
  const [cursor, setCursor] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [aggregates, setAggregates] = useState<Record<string, AggregateFn>>(
    () => readViewConfig(view).aggregates ?? {},
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // 父子行层级里被折叠的父行（只在未分组时生效，与分组折叠各管一套）
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  // CSV 导入：解析完成后先暂存，等用户在 CsvImportDialog 里确认各列类型再落库
  const [importPlan, setImportPlan] = useState<GridImportPlan | null>(null);
  // TSV 粘贴的锚点：最近一次点击的可编辑单元格（粘贴从这里向右向下展开）
  const pasteAnchorRef = useRef<{ rowId: string; fieldId: string } | null>(null);

  useEffect(() => {
    load(view).catch((e: unknown) => logger.error("grid.load", e));
  }, [load, view]);

  // 换视图才清空多选/光标（同一视图的树快照刷新不打断编辑）
  useEffect(() => {
    setCheckedRows(new Set());
    setCursor(null);
    setCollapsedRows(new Set());
  }, [view.id]);

  // <table> 的 ref：表头里的列宽拖拽按它找 <col>
  const tableRef = useRef<HTMLTableElement | null>(null);
  // 视图状态与批量行命令由 MVVM 层算好：这里只留本地 UI 状态与渲染接线
  const { model, displayCells, sortableCells, relationDbOf, runDeleteCheckedRows, runDuplicateCheckedRows } =
    useGridViewModel({
      groupFieldIds,
      collapsedGroups,
      collapsedRows,
      checkedRows,
      aggregates,
      setCheckedRows,
    });
  const {
    visibleFields,
    primaryField,
    displayRows,
    displayRowIds,
    selectedIds,
    allSelected,
    groupableFields,
    groups,
    hasAggregates,
    aggregateOf,
    flatLines,
    collapsedKey,
  } = model;

  // 条件格式：规则、取色索引与编辑弹窗由共用条子接管（传求值后的展示图，公式列也能当条件）
  const cond = useCondFormat(view, displayRowIds, displayCells);

  const toggleRowChecked = (rowId: string) => {
    // 用上回调形式：连点同一行时不能都基于同一份旧集合
    setCheckedRows((prev) => updateRowChecked(prev, rowId));
  };

  // 批量改值读的是存储值（不是计算列的展示值）：cells 为按行稀疏映射，没写过的格子按空值算
  const readStoredCell = useCallback((rowId: string, fieldId: string) => cellAt(cells, rowId, fieldId), [cells]);

  const toggleSelectAll = () => setCheckedRows(updateAllRowsChecked(displayRows, allSelected));

  // 搜索命中定位：折叠键作 revision，命中行所在分组一展开就能重新定位
  const { scrollerRef, focusRowId } = useRowFocus(collapsedKey);

  // ---------- 大表窗口化（分组模式同样生效） ----------
  // 行高固定（td h-8），条目数超阈值时只渲染视口附近的行，上下用占位行撑住滚动条；
  // 阈值以下走原路径，小表零行为变化。分组时组头/小计作为线性条目参与窗口化，
  // 各自高度先走兜底常量，DOM 出现后测量纠正。
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const rowHeightRef = useRef(ROW_H_FALLBACK);
  const groupLineHRef = useRef<{ header: number; subtotal: number }>({
    header: GROUP_LINE_H_FALLBACK,
    subtotal: GROUP_LINE_H_FALLBACK,
  });
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const virtual = flatLines.length > VIRTUAL_MIN_ROWS;

  const lineHeights = useCallback(
    () => lineHeightsOf(flatLines, rowHeightRef.current, groupLineHRef.current.header, groupLineHRef.current.subtotal),
    [flatLines],
  );

  // 量出"数据区在滚动内容里的 y 偏移"再折算窗口：表头高度随缩放/字体变化，写死常量会越滚越偏
  const measureWindow = useCallback(() => {
    const el = scrollerRef.current;
    const body = tbodyRef.current;
    if (!el || !body) return;
    const first = body.querySelector<HTMLElement>("tr[data-row-id]");
    if (first?.offsetHeight) rowHeightRef.current = first.offsetHeight;
    const hdr = body.querySelector<HTMLElement>("tr[data-group-header]");
    if (hdr?.offsetHeight) groupLineHRef.current.header = hdr.offsetHeight;
    const sub = body.querySelector<HTMLElement>("tr[data-subtotal]");
    if (sub?.offsetHeight) groupLineHRef.current.subtotal = sub.offsetHeight;
    const dataTop = body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const next = groups
      ? computeWindowFromHeights({
          scrollTop: el.scrollTop,
          dataTop,
          clientHeight: el.clientHeight,
          heights: lineHeights(),
        })
      : computeVirtualWindow({
          scrollTop: el.scrollTop,
          dataTop,
          clientHeight: el.clientHeight,
          // 层级模式折叠父行会让可见行数少于 displayRows，窗口化只看真正渲染的条目
          total: flatLines.length,
          rowHeight: rowHeightRef.current,
        });
    setWin((prev) => (prev?.start === next.start && prev.end === next.end ? prev : next));
  }, [scrollerRef, flatLines.length, groups, lineHeights]);

  useEffect(() => {
    if (!virtual) {
      setWin(null);
      return;
    }
    const el = scrollerRef.current;
    if (!el) return;
    measureWindow();
    const onScroll = () => measureWindow();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => measureWindow());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [virtual, measureWindow, scrollerRef]);

  /** 把某条线性条目滚到视口中央（窗口化下目标可能没渲染，先滚过去下一帧才找得到 DOM） */
  const scrollToLine = useCallback(
    (index: number) => {
      const el = scrollerRef.current;
      const body = tbodyRef.current;
      if (index < 0 || !el || !body) return;
      const dataTop = body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const top = groups ? offsetOfHeights(lineHeights(), index) : index * rowHeightRef.current;
      el.scrollTo({ top: Math.max(0, dataTop + top - el.clientHeight / 2) });
    },
    [scrollerRef, groups, lineHeights],
  );

  const lineIndexOfRow = useCallback(
    (rowId: string) => flatLines.findIndex((l) => l.kind === "row" && l.row.id === rowId),
    [flatLines],
  );

  // 命中行在窗口外时先滚过去，等下一帧 useRowFocus 的 DOM 查询才找得到它
  useEffect(() => {
    if (!focusRowId || !virtual) return;
    const idx = lineIndexOfRow(focusRowId);
    if (idx < 0) return;
    if (win && idx >= win.start && idx < win.end) return;
    scrollToLine(idx);
  }, [focusRowId, virtual, lineIndexOfRow, win, scrollToLine]);

  useEffect(() => {
    if (!focusRowId || !groups) return;
    // 命中行在多层组里：从顶层到叶子逐层展开，只解最内层会让它藏在折叠的父组下面
    const chain = groupPathOfRow(groups, focusRowId).filter((path) => collapsedGroups.has(path));
    if (chain.length === 0) return;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      for (const path of chain) next.delete(path);
      return next;
    });
  }, [focusRowId, groups, collapsedGroups]);

  // 未分组时命中行可能藏在折叠的父行下面：同样按祖先链逐层展开
  useEffect(() => {
    if (!focusRowId || groups) return;
    const chain = collapsedAncestorsOfRow(displayRows, collapsedRows, focusRowId);
    if (chain.length === 0) return;
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      for (const id of chain) next.delete(id);
      return next;
    });
  }, [focusRowId, groups, displayRows, collapsedRows]);

  // ---------- 键盘导航 ----------
  // 上下键沿屏幕上的视觉行序走：分组按组展开顺序、层级按树序，折叠掉的行不在其中
  // （否则会跳到看不见的行，光标与滚动区脱节）
  const navRows = useMemo(
    () => flatLines.filter((l): l is Extract<GridFlatLine, { kind: "row" }> => l.kind === "row").map((l) => l.row),
    [flatLines],
  );

  /** 光标移动：越界即夹紧；虚拟窗口外的行先滚过去，渲染完成后再聚焦 */
  const moveCursorTo = (rowIndex: number, colIndex: number) => {
    const ri = Math.max(0, Math.min(navRows.length - 1, rowIndex));
    const ci = Math.max(0, Math.min(visibleFields.length - 1, colIndex));
    if (navRows.length === 0 || visibleFields.length === 0) return;
    const row = navRows[ri];
    const field = visibleFields[ci];
    // 分组窗口化后行号与物理行不再一一对应：以"目标单元格是否在 DOM 里"决定要不要先滚过去
    if (virtual) {
      const el = scrollerRef.current;
      if (el && !el.querySelector(cellSelector({ rowId: row.id, fieldId: field.id }))) {
        scrollToLine(lineIndexOfRow(row.id));
      }
    }
    setCursor({ rowId: row.id, fieldId: field.id });
  };

  // 光标落定后聚焦对应单元格；虚拟化下目标行可能还没渲染，重试几帧
  useEffect(() => {
    if (!cursor || editing) return;
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const attempt = (tries: number) => {
      const td = el.querySelector<HTMLElement>(cellSelector(cursor));
      if (td) {
        td.focus({ preventScroll: true });
        td.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      if (tries > 0) raf = requestAnimationFrame(() => attempt(tries - 1));
    };
    attempt(3);
    return () => cancelAnimationFrame(raf);
  }, [cursor, editing, scrollerRef]);

  // TSV 粘贴锚点跟随键盘光标：键盘选好位置后直接 Ctrl+V 就有落点
  useEffect(() => {
    if (!cursor) return;
    const field = visibleFields.find((f) => f.id === cursor.fieldId);
    if (field && !isReadonlyType(field.field_type)) pasteAnchorRef.current = cursor;
  }, [cursor, visibleFields]);

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !cursor) return;
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.closest("td[data-cell-row]")) return;
    const ri = navRows.findIndex((r) => r.id === cursor.rowId);
    const ci = visibleFields.findIndex((f) => f.id === cursor.fieldId);
    if (ri < 0 || ci < 0) return;
    const field = visibleFields.find((f) => f.id === cursor.fieldId);
    // 空单元格在 cells 里没有键，按空值参与判定（cellAt 统一这份稀疏映射的读法）
    const readCell = (rowId: string, fieldId: string) => cellAt(cells, rowId, fieldId);
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveCursorTo(ri - 1, ci);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveCursorTo(ri + 1, ci);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveCursorTo(ri, ci - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveCursorTo(ri, ci + 1);
        break;
      case "Tab": {
        // 行尾 Tab 跳到下一行行首（表格连续感）
        e.preventDefault();
        const next = ci + (e.shiftKey ? -1 : 1);
        if (next >= visibleFields.length) moveCursorTo(ri + 1, 0);
        else if (next < 0) moveCursorTo(ri - 1, visibleFields.length - 1);
        else moveCursorTo(ri, next);
        break;
      }
      case "Enter": {
        if (!field || isReadonlyType(field.field_type)) break;
        e.preventDefault();
        if (field.field_type === "checkbox") {
          void commitCell(cursor.rowId, field.id, readCell(cursor.rowId, field.id) !== true);
        } else {
          setEditing({ rowId: cursor.rowId, fieldId: field.id });
        }
        break;
      }
      case " ": {
        if (field?.field_type !== "checkbox") break;
        e.preventDefault();
        void commitCell(cursor.rowId, field.id, readCell(cursor.rowId, field.id) !== true);
        break;
      }
      case "Delete": {
        if (!field || isReadonlyType(field.field_type) || readCell(cursor.rowId, field.id) == null) break;
        e.preventDefault();
        void commitCell(cursor.rowId, field.id, null);
        break;
      }
      case "Escape":
        e.preventDefault();
        setCursor(null);
        if (target instanceof HTMLElement) target.blur();
        break;
    }
  };

  /** 改分组层级（增/删/换某一层的字段）：组的 key 由字段值决定，层级一变旧的折叠状态就没意义了 */
  const setGroupLevels = (ids: string[]) => {
    setGroupFieldIds(ids);
    setCollapsedGroups(new Set());
    patchViewConfig(view, { groupFieldIds: ids });
  };

  const changeAggregate = (fieldId: string, fn: AggregateFn | undefined) => {
    const next: Record<string, AggregateFn> = {};
    for (const [id, value] of Object.entries(aggregates)) if (id !== fieldId) next[id] = value;
    if (fn) next[fieldId] = fn;
    setAggregates(next);
    patchViewConfig(view, { aggregates: next });
  };

  const commitCell = useCallback(
    async (rowId: string, fieldId: string, value: CellValue) => {
      setEditing(null);
      try {
        await store.setCell(rowId, fieldId, value);
      } catch (e) {
        logger.error("set cell failed", e);
        toast.error(t("error.db", { message: String(e) }));
      }
    },

    [store],
  );

  const addRow = async () => {
    try {
      await store.addRow();
    } catch (e) {
      logger.error("add row failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // ---------- 父子行层级：挂接动作（展开/折叠只在本地视图，见 collapsedRows） ----------
  const [parentTarget, setParentTarget] = useState<DatabaseRow | null>(null);

  // 分组的行不带树形层深（组优先铺行），行菜单仍要按真实层深判断能不能再往下挂
  const rowDepthOf = useMemo(() => {
    const map = new Map(hierarchyLines(rows).map((l) => [l.row.id, l.depth]));
    return (rowId: string) => map.get(rowId) ?? 1;
  }, [rows]);

  /** 选父行列表与提示用的行标题：主列的显示值，空值兜底成「（空行）」 */
  const rowLabelOf = useCallback(
    (rowId: string) => {
      if (!primaryField) return rowId;
      // 计算列在存储图里没有值，取屏上算好的展示值；被筛掉（不在展示图里）的候选回落成存储值
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 展示图只覆盖当前可见行
      const value = displayCells[rowId]?.[primaryField.id] ?? cellAt(cells, rowId, primaryField.id);
      const text = formatCellValue(primaryField.field_type, value, parseFieldOptions(primaryField.options)).trim();
      return text || t("row.trashUntitled");
    },
    [primaryField, displayCells, cells],
  );

  const addChildRow = async (row: DatabaseRow) => {
    try {
      await store.addRow(row.id);
      // 折叠中的父行下新建子行会看不见：顺手展开它
      setCollapsedRows((prev) => {
        if (!prev.has(row.id)) return prev;
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      toast.success(t("row.childAdded", { name: rowLabelOf(row.id) }));
    } catch (e) {
      logger.error("add child row failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const detachParent = async (row: DatabaseRow) => {
    try {
      await store.setRowParent(row.id, null);
      toast.success(t("row.parentDetached"));
    } catch (e) {
      logger.error("detach row parent failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const pickParent = async (row: DatabaseRow, parentId: string | null) => {
    if ((row.parent_id ?? null) === parentId) return;
    try {
      await store.setRowParent(row.id, parentId);
      toast.success(parentId ? t("row.parentSet", { name: rowLabelOf(parentId) }) : t("row.parentDetached"));
    } catch (e) {
      // 超深/成环在这里由 Rust 侧挡下（见 db::database::validate_parent），把原因原样递给用户
      logger.error("set row parent failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // 行拖拽：默认改行序；按住 Alt 落到某个合法父行上 = 挂成它的子行（落点判定见 planRowDrop）
  const [nestHint, setNestHint] = useState<string | null>(null);
  const nestCandidates = useMemo(
    () => new Set(draggingRow ? parentCandidates(rows, draggingRow).map((r) => r.id) : []),
    [draggingRow, rows],
  );
  const onRowDrop = (targetId: string, mode: RowDropMode) => {
    const draggingId = draggingRow;
    setDraggingRow(null);
    setNestHint(null);
    if (!draggingId) return;
    // 全量重排（store 顺序 = position 顺序）：传 displayRows 会把被筛选掉的行从 store.rows 里剔除
    const plan = planRowDrop({ rows, draggingId, targetId, mode });
    if (!plan) return;
    if (plan.kind === "reorder") {
      void store.reorderRows(plan.ids);
      return;
    }
    const row = rows.find((r) => r.id === plan.rowId);
    if (row) void pickParent(row, plan.parentId);
  };

  // CSV / xlsx 导出与 CSV / TSV 导入整簇在 grid-io-slice.ts：行列单元格与 store 按当前渲染值注入
  const { exportCsv, exportXlsx, onPasteTsv, importCsv, runImportCsv } = createGridIoSlice({
    source,
    fields,
    cells,
    displayRows,
    displayCells,
    relationDbOf,
    visibleFields,
    editing,
    pasteAnchorRef,
    store,
    storeApi,
    importPlan,
    setImportPlan,
  });

  // 单行渲染：不分组时顺序铺开，分组时按组铺开（组内顺序沿用当前视图排序）
  // 行内容搬到 grid-row.tsx（普通函数而非组件，调用方式与行为与原内联 renderRow 一致）
  const rowCtx: GridRowContext = {
    store,
    source,
    visibleFields,
    primaryField,
    editing,
    cells: displayCells,
    checkedRows,
    focusRowId,
    draggingRow,
    setDraggingRow,
    onRowDrop,
    nestCandidates,
    nestHintRowId: nestHint,
    setNestHint,
    toggleRowChecked,
    setDeleteRowTarget,
    onAddChildRow: (row) => void addChildRow(row),
    onPickParent: setParentTarget,
    onDetachParent: (row) => void detachParent(row),
    rowDepthOf,
    commitCell,
    setCursor,
    setEditing,
    pasteAnchorRef,
    condToneIndex: cond.index,
  };
  /** 折叠/展开某父行的子树（只影响本地视图，不落库） */
  const toggleRowCollapse = (rowId: string) => {
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const renderRow = (row: DatabaseRow, hier?: GridRowHierarchy) => renderGridRow(row, rowCtx, hier);

  // 线性条目渲染：组头 / 数据行 / 组小计（窗口化切片直接 map 它）
  const renderLine = (line: GridFlatLine) => {
    if (line.kind === "row")
      return renderRow(
        line.row,
        line.depth === undefined
          ? undefined
          : {
              depth: line.depth,
              hasChildren: line.hasChildren === true,
              collapsed: line.collapsed === true,
              onToggle: () => toggleRowCollapse(line.row.id),
            },
      );
    if (line.kind === "header")
      return (
        <GridGroupHeaderRow
          key={"hdr_" + line.key}
          label={line.label}
          count={line.count}
          collapsed={line.collapsed}
          depth={line.depth}
          onToggle={() => toggleGroup(line.key)}
          colSpan={visibleFields.length + 2}
        />
      );
    return (
      <GridSubtotalRow
        key={"sub_" + line.key}
        rowIds={line.rowIds}
        scopeRowIds={displayRowIds}
        visibleFields={visibleFields}
        aggregateOf={aggregateOf}
        cells={sortableCells}
      />
    );
  };

  const toggleGroup = (key: string) => {
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsedGroups(next);
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏（说明书 6.2：高 44px）：左侧是页内视图切换（宿主 chip 双击即重命名页面），
          页面名已由侧边栏/标签页承载，这里不再重复 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <div className="flex min-w-0 flex-1 items-center">{tabs}</div>
        <div className="flex shrink-0 items-center gap-1">
          {/* 多选操作条：勾了行才出现，避免常驻占位 */}
          {selectedIds.length > 0 && (
            <div className="mr-1 flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300">
              <span data-testid="selected-count">{t("row.selected", { count: String(selectedIds.length) })}</span>
              <Button variant="ghost" size="sm" onClick={runDuplicateCheckedRows}>
                <Copy className="h-3.5 w-3.5" />
                {t("row.duplicateSelected")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setBulkEditOpen(true)}>
                <SquarePen className="h-3.5 w-3.5" />
                {t("row.bulkEdit")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:bg-red-100 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-500/10"
                onClick={() => setDeleteSelectedOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("row.deleteSelected")}
              </Button>
              <button
                className="flex h-5 w-5 items-center justify-center rounded text-brand-500 hover:bg-brand-100 dark:hover:bg-brand-500/20"
                title={t("row.selectionClear")}
                aria-label={t("row.selectionClear")}
                onClick={() => setCheckedRows(new Set())}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {/* 分组层级：按顺序逐层下钻，每层一个下拉 + 移除，末尾一个「再加一层」 */}
          {groupableFields.length > 0 && (
            <div className="flex items-center gap-1.5">
              {groupFieldIds.map((id, level) => {
                const field = groupableFields.find((f) => f.id === id);
                if (!field) return null;
                return (
                  <div
                    key={id}
                    className="flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700"
                  >
                    <span className="text-neutral-500">{t(level === 0 ? "grid.groupBy" : "grid.thenBy")}:</span>
                    <select
                      className="bg-transparent text-xs outline-none"
                      aria-label={t(level === 0 ? "grid.groupBy" : "grid.thenBy")}
                      value={id}
                      onChange={(e) => setGroupLevels(groupFieldIds.map((x, i) => (i === level ? e.target.value : x)))}
                    >
                      {groupableFields
                        .filter((f) => f.id === id || !groupFieldIds.includes(f.id))
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </select>
                    <button
                      className="flex h-4 w-4 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-red-500"
                      title={t("grid.removeGroup")}
                      aria-label={t("grid.removeGroup")}
                      onClick={() => setGroupLevels(groupFieldIds.filter((_, i) => i !== level))}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {groupFieldIds.length < MAX_GROUP_DEPTH && (
                <select
                  className="h-6 rounded-md border border-dashed border-neutral-300 bg-transparent px-1.5 text-xs text-neutral-500 outline-none hover:border-brand-500"
                  value=""
                  title={t("grid.addGroup")}
                  aria-label={t("grid.addGroup")}
                  onChange={(e) => e.target.value && setGroupLevels([...groupFieldIds, e.target.value])}
                >
                  <option value="">{t("grid.groupBy")}</option>
                  {groupableFields
                    .filter((f) => !groupFieldIds.includes(f.id))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => setRowTrashOpen(true)} title={t("row.trash")}>
            <Archive className="h-3.5 w-3.5" />
            {t("row.trash")}
          </Button>
          <HiddenColumnsMenu fields={fields} onShow={(id) => void store.toggleFieldHidden(id)} />
          <CondFormatButton bar={cond} />
          <QueryButtons bar={bar} />
          <Button variant="ghost" size="sm" onClick={importCsv}>
            <FileUp className="h-3.5 w-3.5" />
            {t("csv.import")}
          </Button>
          <Button variant="ghost" size="sm" onClick={exportCsv}>
            <Download className="h-3.5 w-3.5" />
            {t("csv.export")}
          </Button>
          <Button variant="ghost" size="sm" onClick={exportXlsx}>
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {t("xlsx.export")}
          </Button>
        </div>
      </div>

      <QueryPanels bar={bar} />

      {/* 表格（横向滚动；TSV 剪贴板粘贴见 onPasteTsv） */}
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onPaste={(e) => void onPasteTsv(e)}
        onKeyDown={onGridKeyDown}
      >
        <table ref={tableRef} className="border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: 44 }} />
            {visibleFields.map((f) => (
              <col key={f.id} data-field-id={f.id} style={{ width: f.width }} />
            ))}
            <col style={{ width: 44 }} />
          </colgroup>
          <GridHeaderRow
            visibleFields={visibleFields}
            primaryField={primaryField}
            tableRef={tableRef}
            allSelected={allSelected}
            onToggleSelectAll={toggleSelectAll}
            onConfigure={setOptionsEditorFor}
          />
          <tbody ref={tbodyRef}>
            {virtual
              ? (() => {
                  // 首次 commit 还没量过窗口：先渲染开头一段，effect 量完立刻纠正
                  const start = win?.start ?? 0;
                  const end = win?.end ?? Math.min(flatLines.length, VIRTUAL_OVERSCAN * 4);
                  const heights = groups ? lineHeights() : null;
                  const above = heights ? offsetOfHeights(heights, start) : start * rowHeightRef.current;
                  const below = heights
                    ? offsetOfHeights(heights, heights.length) - offsetOfHeights(heights, end)
                    : (flatLines.length - end) * rowHeightRef.current;
                  return (
                    <>
                      {above > 0 && <GridSpacerRow height={above} colSpan={visibleFields.length + 2} />}
                      {flatLines.slice(start, end).map(renderLine)}
                      {below > 0 && <GridSpacerRow height={below} colSpan={visibleFields.length + 2} />}
                    </>
                  );
                })()
              : flatLines.map(renderLine)}
            {/* 新建行：跨整行底部，避免无字段时挤在窄列里 */}
            <GridAddRow colSpan={1 + visibleFields.length + 1} onAdd={addRow} />
          </tbody>
          {/* 底部汇总行：每列一个可点的汇总函数，就地显示结果（无边框，与数据区视觉分离） */}
          <tfoot>
            <tr>
              <td className="px-1 pt-1 text-right text-[11px] text-neutral-400">{t("grid.total")}</td>
              {visibleFields.map((field, index) => (
                <td key={field.id} className="h-8 p-0 align-middle">
                  {(hasAggregates || index === 0) && (
                    <AggregateMenu
                      field={field}
                      fn={aggregateOf(field)}
                      rowIds={displayRowIds}
                      cells={sortableCells}
                      onPick={(fn) => changeAggregate(field.id, fn)}
                    />
                  )}
                </td>
              ))}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 拖行中才出现的落点说明：默认只改行序，按住 Alt 落到合法父行上才嵌套 */}
      {draggingRow && (
        <div className="pointer-events-none absolute bottom-4 left-6 z-20 rounded-md bg-neutral-900/85 px-3 py-1.5 text-[11px] text-white shadow-sm dark:bg-neutral-800/90">
          {t("row.dragNestHint")}
        </div>
      )}

      {optionsEditorFor && (
        <FieldOptionsEditor
          field={optionsEditorFor}
          open
          onOpenChange={(open) => {
            if (!open) setOptionsEditorFor(null);
          }}
          onSave={(opts) => void store.updateFieldOptions(optionsEditorFor.id, opts)}
        />
      )}

      <ConfirmDialog
        open={deleteRowTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRowTarget(null);
        }}
        title={t("row.deleteConfirmTitle")}
        description={t("row.deleteConfirmDesc")}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          const row = deleteRowTarget;
          setDeleteRowTarget(null);
          if (!row) return;
          store
            .removeRow(row.id)
            .then(() => toast.success(t("row.deleted")))
            .catch((e: unknown) => toast.error(t("error.db", { message: String(e) })));
        }}
      />

      <ConfirmDialog
        open={deleteSelectedOpen}
        onOpenChange={setDeleteSelectedOpen}
        title={t("row.deleteSelectedConfirmTitle")}
        description={t("row.deleteSelectedConfirmDesc", { count: String(selectedIds.length) })}
        confirmLabel={t("common.delete")}
        onConfirm={() => void runDeleteCheckedRows()}
      />

      <RowTrashDialog open={rowTrashOpen} onOpenChange={setRowTrashOpen} />

      {/* 选父行：候选已滤掉自己/后代/会超深的行，选到的一定合法 */}
      <RowParentDialog
        open={parentTarget !== null}
        onOpenChange={(next) => {
          if (!next) setParentTarget(null);
        }}
        rows={rows}
        row={parentTarget}
        labelOf={rowLabelOf}
        onPick={(parentId) => {
          const row = parentTarget;
          setParentTarget(null);
          if (row) void pickParent(row, parentId);
        }}
      />

      {/* 条件格式规则编辑（与其余视图同一份按视图持久化的配置） */}
      <CondFormatDialogHost bar={cond} />

      {/* 批量改值：改完清掉勾选，避免「刚改的行还挂着选」让人以为没生效 */}
      <BulkEditDialog
        open={bulkEditOpen}
        onOpenChange={setBulkEditOpen}
        fields={fields}
        rowIds={selectedIds}
        readCell={readStoredCell}
        onApply={async (updates) => {
          await store.setCellsMany(updates);
          setCheckedRows(new Set());
        }}
      />

      {/* CSV 导入确认：逐列选类型 + 附件列选文件夹（取消则不建视图）；可选追加到当前表 */}
      {importPlan && (
        <CsvImportDialog
          headers={importPlan.headers}
          initialTypes={importPlan.types}
          dataRows={importPlan.dataRows}
          appendTarget={{
            name: source.name,
            fields: fields.map((f) => ({ name: f.name, field_type: f.field_type })),
          }}
          onCancel={() => setImportPlan(null)}
          onConfirm={(types, foldersByColumn, target) => void runImportCsv(types, foldersByColumn, target)}
        />
      )}

      {/* 行详情右侧滑出面板（说明书 6.1：宽 400px） */}
      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}
