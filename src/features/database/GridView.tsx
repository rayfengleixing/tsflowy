import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Archive,
  ArrowUpDown,
  CheckSquare,
  Copy,
  Download,
  FileUp,
  Filter,
  GripVertical,
  Square,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import type { AttachmentRef, CellValue, DatabaseField, DatabaseRow, FieldType } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDbStore, useDbStoreApi } from "@/stores/database-context";
import { useWorkspaceStore } from "@/stores/workspace";
import { viewApi, newId } from "@/lib/db";
import { isOptionBearing, parseFieldOptions, sparseGet } from "@/lib/database-values";
import type { SortSpec } from "@/lib/database-query";
import type { AggregateFn } from "@/lib/database-aggregate";
import {
  buildCsvExport,
  buildSelectOptions,
  collectSelectNames,
  importCell,
  parseCsv,
  pasteCell,
  planImport,
  parseTsv,
  resolveAttachmentNames,
  type PasteDeps,
} from "@/lib/csv";
import { CsvImportDialog } from "./CsvImportDialog";
import { RowTrashDialog } from "./RowTrashDialog";
import { BulkEditDialog } from "./BulkEditDialog";
import { relationRowIds, relationRowLabel, relationTarget } from "@/lib/relation";
import { useGridViewModel } from "./use-grid-view-model";
import { toggleRowChecked as updateRowChecked, toggleAllRowsChecked as updateAllRowsChecked } from "./grid-view-model";
import { FieldMenu } from "./FieldMenu";
import { FieldOptionsEditor } from "./FieldOptionsEditor";
import { FilterBar } from "./FilterBar";
import { SortBar } from "./SortBar";
import { AggregateMenu } from "./AggregateMenu";
import { useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import { AddFieldButton, HiddenColumnsMenu, RenameInput, needsFieldSettings } from "./grid-parts";
import { renderGridRow, type GridRowContext } from "./grid-row";
import { GridAddRow, GridGroupHeaderRow, GridSpacerRow, GridSubtotalRow } from "./grid-rows";
import {
  GROUP_LINE_H_FALLBACK,
  ROW_H_FALLBACK,
  VIRTUAL_MIN_ROWS,
  VIRTUAL_OVERSCAN,
  cellSelector,
  clampColumnWidth,
  computeVirtualWindow,
  computeWindowFromHeights,
  lineHeightsOf,
  mapWithConcurrency,
  offsetOfHeights,
  type GridFlatLine,
} from "./grid-view-helpers";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";

import { cn } from "@/lib/utils";
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
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { closeRowDetail } = store;

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [renamingField, setRenamingField] = useState<string | null>(null);
  const [optionsEditorFor, setOptionsEditorFor] = useState<DatabaseField | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // 待确认删除的行（删行=进回收站，确认后仍可在「回收站」里恢复）
  const [deleteRowTarget, setDeleteRowTarget] = useState<DatabaseRow | null>(null);
  const [rowTrashOpen, setRowTrashOpen] = useState(false);
  // 多选行（序号列勾选框）：键为 rowId；实际生效集合每次按可见行求交，行被删/被筛走都不会残留
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  // 批量改值弹窗：勾选行 + 一个字段一次改完
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [draggingField, setDraggingField] = useState<string | null>(null);
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [groupFieldId, setGroupFieldId] = useState<string | null>(() => readViewConfig(view).groupFieldId ?? null);
  // 键盘光标（↑↓←→/Tab 移动、Enter 编辑、Delete 清空、Esc 退出）
  const [cursor, setCursor] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [aggregates, setAggregates] = useState<Record<string, AggregateFn>>(
    () => readViewConfig(view).aggregates ?? {},
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // CSV 导入：解析完成后先暂存，等用户在 CsvImportDialog 里确认各列类型再落库
  const [importPlan, setImportPlan] = useState<{
    fileName: string;
    headers: string[];
    types: FieldType[];
    /** 数据行（不含表头） */
    dataRows: string[][];
  } | null>(null);
  // TSV 粘贴的锚点：最近一次点击的可编辑单元格（粘贴从这里向右向下展开）
  const pasteAnchorRef = useRef<{ rowId: string; fieldId: string } | null>(null);

  useEffect(() => {
    load(view).catch((e: unknown) => logger.error("grid.load", e));
  }, [load, view]);

  // 换视图才清空多选/光标（同一视图的树快照刷新不打断编辑）
  useEffect(() => {
    setCheckedRows(new Set());
    setCursor(null);
  }, [view.id]);

  // 列宽拖拽：拖拽期间直接改 <col> 宽度（纯 DOM，零重渲/零 IPC），mouseup 才落库一次
  const tableRef = useRef<HTMLTableElement | null>(null);
  const startColumnResize = (e: ReactMouseEvent, fieldId: string, startWidth: number) => {
    e.preventDefault();
    const col = tableRef.current?.querySelector<HTMLTableColElement>(`col[data-field-id="${fieldId}"]`);
    if (!col) return;
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      col.style.width = clampColumnWidth(startWidth + ev.clientX - startX) + "px";
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const width = clampColumnWidth(startWidth + ev.clientX - startX);
      void store.setFieldWidth(fieldId, width).catch((err: unknown) => {
        col.style.width = ""; // 落库失败：去掉本地预览宽度，回退 store 旧值
        logger.error("set field width failed", err);
        toast.error(t("error.db", { message: String(err) }));
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 视图状态与批量行命令由 MVVM 层算好：这里只留本地 UI 状态与渲染接线
  const { model, displayCells, sortableCells, relationDbOf, runDeleteCheckedRows, runDuplicateCheckedRows } =
    useGridViewModel({
      groupFieldId,
      collapsedGroups,
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

  const toggleRowChecked = (rowId: string) => {
    // 用上回调形式：连点同一行时不能都基于同一份旧集合
    setCheckedRows((prev) => updateRowChecked(prev, rowId));
  };

  // 批量改值读的是存储值（不是计算列的展示值）：cells 为按行稀疏映射，没写过的格子没有条目
  const readStoredCell = useCallback(
    (rowId: string, fieldId: string): CellValue | undefined => {
      const rowCells = sparseGet(cells, rowId);
      return rowCells ? sparseGet(rowCells, fieldId) : undefined;
    },
    [cells],
  );

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
          total: displayRows.length,
          rowHeight: rowHeightRef.current,
        });
    setWin((prev) => (prev?.start === next.start && prev.end === next.end ? prev : next));
  }, [scrollerRef, displayRows.length, groups, lineHeights]);

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
    const hit = groups.find((g) => g.rows.some((r) => r.id === focusRowId));
    if (!hit || !collapsedGroups.has(hit.key)) return;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.delete(hit.key);
      return next;
    });
  }, [focusRowId, groups, collapsedGroups]);

  // ---------- 键盘导航 ----------
  /** 光标移动：越界即夹紧；虚拟窗口外的行先滚过去，渲染完成后再聚焦 */
  const moveCursorTo = (rowIndex: number, colIndex: number) => {
    const ri = Math.max(0, Math.min(displayRows.length - 1, rowIndex));
    const ci = Math.max(0, Math.min(visibleFields.length - 1, colIndex));
    if (displayRows.length === 0 || visibleFields.length === 0) return;
    const row = displayRows[ri];
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
    const ri = displayRows.findIndex((r) => r.id === cursor.rowId);
    const ci = visibleFields.findIndex((f) => f.id === cursor.fieldId);
    if (ri < 0 || ci < 0) return;
    const field = visibleFields.find((f) => f.id === cursor.fieldId);
    // 空单元格在 cells 里没有键，取值可能是 undefined；断言让这里如实反映
    const readCell = (rowId: string, fieldId: string): CellValue | undefined => {
      const rowCells = cells[rowId] as Record<string, CellValue> | undefined;
      return rowCells?.[fieldId];
    };
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

  const changeGroupField = (id: string | null) => {
    setGroupFieldId(id);
    setCollapsedGroups(new Set());
    patchViewConfig(view, { groupFieldId: id ?? "" });
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

  // 表头单击：没排过 → 追加升序；升序 → 转降序；降序 → 取消该字段（其余字段保持）
  const cycleSort = (fieldId: string) => {
    const current = sorts.find((s) => s.field_id === fieldId);
    const next: SortSpec[] = !current
      ? [...sorts, { field_id: fieldId, dir: "asc" }]
      : current.dir === "asc"
        ? sorts.map((s) => (s.field_id === fieldId ? { ...s, dir: "desc" as const } : s))
        : sorts.filter((s) => s.field_id !== fieldId);
    store.setSorts(next);
  };

  const addRow = async () => {
    try {
      await store.addRow();
    } catch (e) {
      logger.error("add row failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // 字段拖拽排序（主列固定首位，只在其它列之间排序）
  const onFieldDrop = (targetId: string) => {
    if (!draggingField || draggingField === targetId) return;
    if (draggingField === primaryField?.id || targetId === primaryField?.id) return;
    // 全量重排（含隐藏列）：传 visibleFields 会把隐藏字段从 store.fields 里剔除
    const sortable = fields.filter((f) => f.id !== primaryField?.id).map((f) => f.id);
    const from = sortable.indexOf(draggingField);
    const to = sortable.indexOf(targetId);
    if (from < 0 || to < 0) return;
    sortable.splice(to, 0, sortable.splice(from, 1)[0]);
    void store.reorderFields([primaryField?.id, ...sortable].filter((id): id is string => Boolean(id)));
    setDraggingField(null);
  };

  // 行拖拽排序
  const onRowDrop = (targetId: string) => {
    if (!draggingRow || draggingRow === targetId) return;
    // 全量重排（store 顺序 = position 顺序）：传 displayRows 会把被筛选掉的行从 store.rows 里剔除
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(draggingRow);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void store.reorderRows(ids);
    setDraggingRow(null);
  };

  // CSV 导出（公式列在导出前注入算好的值；只导出当前筛选/排序后的可见行）
  const exportCsv = async () => {
    try {
      // 计算列直读展示图（渲染期已按行求值一次，不再为导出重算一遍）
      const cellsWithFormula = { ...cells };
      for (const row of displayRows) {
        const rowCells = cells[row.id] ?? {};
        const display = displayCells[row.id] ?? {};
        for (const f of fields) {
          if (f.field_type === "relation") {
            // 导出成行标题而不是行 id：导出的 CSV 才对人可读
            const db = relationDbOf(relationTarget(f) ?? "");
            const text = relationRowIds(rowCells[f.id] ?? null)
              .map((id) => (db ? relationRowLabel(db, id) : null) ?? id)
              .join("; ");
            cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: text };
          } else if (f.field_type === "reverse_relation") {
            // 反向关系无存储值：来源行 id 同样翻成标题
            const ids = Array.isArray(display[f.id]) ? (display[f.id] as string[]) : [];
            const cfg = parseFieldOptions(f.options);
            const db = cfg.kind === "reverse_relation" ? relationDbOf(cfg.source_view_id) : undefined;
            const text = ids.map((id) => (db ? relationRowLabel(db, id) : null) ?? id).join("; ");
            if (text !== "") cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: text };
          } else if (f.field_type === "formula" || f.field_type === "rollup") {
            const v = display[f.id] ?? null;
            if (v !== null) cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: v };
          }
        }
      }
      // 前置 BOM：Excel 打开 UTF-8 CSV 才不会把中文显示成乱码
      const content = "\uFEFF" + buildCsvExport(fields, displayRows, cellsWithFormula);
      const target = await save({
        defaultPath: (source.name || "export").replace(/[\\/:*?"<>|]/g, "_") + ".csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!target) return;
      await invoke("write_text_file", { path: target, content });
      toast.success(t("csv.exported"));
    } catch (e) {
      logger.error("csv export failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  // Excel/表格 TSV 剪贴板粘贴：从锚点单元格向右向下展开，行不够自动补行
  const onPasteTsv = async (e: React.ClipboardEvent) => {
    if (editing) return; // 编辑框里的粘贴走默认（单格文本）
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea")) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text || (!text.includes("\t") && !text.includes("\n"))) return;
    const grid = parseTsv(text);
    if (grid.length === 0 || grid[0].length === 0) return;
    const anchor = pasteAnchorRef.current;
    if (!anchor) {
      toast.info(t("csv.pasteNoAnchor"));
      return;
    }
    e.preventDefault();
    const startRow = displayRows.findIndex((r) => r.id === anchor.rowId);
    const startCol = visibleFields.findIndex((f) => f.id === anchor.fieldId);
    if (startRow < 0 || startCol < 0) return;
    try {
      let skipped = 0;
      // 预取行队列：现有行 + 粘贴时按需新建（一次 IPC 建全部缺行，不再逐行 await）
      const rowQueue: string[] = displayRows.slice(startRow).map((r) => r.id);
      const missingRows = grid.length - rowQueue.length;
      if (missingRows > 0) {
        const created = await store.addRows(missingRows);
        if (created.length !== missingRows) return;
        rowQueue.push(...created.map((r) => r.id));
      }
      // 单元格写入先攒后写：一次 cell_set_many 落整片粘贴（选项补建仍逐条，但那是低频路径）
      const pasteDeps: PasteDeps = {
        latestField: (fieldId) => storeApi.getState().fields.find((f) => f.id === fieldId),
        createOption: (fieldId, name) => store.addSelectOption(fieldId, name),
      };
      const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const field: DatabaseField | undefined = visibleFields[startCol + j];
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- noUncheckedIndexedAccess 关闭使索引返回非空类型，但粘贴网格列数可能超出可见列，运行时会越界返回 undefined
          if (!field) {
            skipped++; // 超出最右列
            continue;
          }
          // 类型怎么读这段文本、缺的选项怎么补，都在 pasteCell 里（与 CSV 追加同一条路径）
          const pasted = await pasteCell(field, grid[i][j], pasteDeps);
          if (!pasted) {
            skipped++; // 只读/关联/附件与未配选项的选择列：文本给不出合法值
            continue;
          }
          if (pasted.degraded) skipped++; // 选项补建失败，写出去的值不完整
          updates.push({ rowId: rowQueue[i], fieldId: field.id, value: pasted.value });
        }
      }
      // 选择类补建过选项时会刷新 fields，但 cells 只在这里写一次，顺序上不冲突
      await store.setCellsMany(updates);
      const filled = updates.length;
      if (filled > 0) toast.success(t("csv.pasted", { n: String(filled) }));
      if (skipped > 0) toast.warning(t("csv.pasteSkipped", { n: String(skipped) }));
    } catch (err) {
      logger.error("tsv paste failed", err);
      toast.error(t("error.csv", { message: String(err) }));
    }
  };

  // CSV 导入（新表）：先选文件并解析，再弹对话框让用户确认各列类型，确认后才落库
  const importCsv = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (typeof selected !== "string") return;
      const text = await invoke<string>("read_text_file", { path: selected });
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        toast.error(t("csv.emptyFile"));
        return;
      }
      const { headers, types } = planImport(parsed);
      // 新表名取文件名
      const base =
        selected
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.csv$/i, "") ?? "";
      const fileName = base.length > 0 ? base : t("csv.importDefaultName");
      setImportPlan({ fileName, headers, types, dataRows: parsed.slice(1) });
    } catch (e) {
      logger.error("csv import failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  /** 追加到当前表：列名匹配现有可写字段（忽略大小写/空白），逐行建空行再批量写单元格；
   *  未匹配或只读派生列跳过并提示。选择列缺的选项当场补建（与 TSV 粘贴同一套路径）。 */
  const runAppendCsv = async (foldersByColumn: Record<number, Record<string, string>>) => {
    const plan = importPlan;
    if (!plan) return;
    try {
      const byName = new Map<string, DatabaseField>();
      for (const f of fields) {
        const key = f.name.trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, f);
      }
      const colTargets = plan.headers.map((h) => {
        const f = byName.get(h.trim().toLowerCase()) ?? null;
        if (!f || isReadonlyType(f.field_type) || f.field_type === "relation") return null;
        return f;
      });
      const skippedCols = colTargets.filter((f) => f === null).length;
      if (colTargets.length > 0 && skippedCols === colTargets.length) {
        toast.error(t("csv.appendNoMatch"));
        return;
      }
      // 附件列与新建表路径同构：文件夹文件名索引 → save_asset 复制 → 写 AttachmentRef 数组
      const pendingSources = new Set<string>();
      const resolved: Record<number, { matched: { name: string; sourcePath: string }[]; missing: string[] }[]> = {};
      colTargets.forEach((f, col) => {
        if (f?.field_type !== "attachment") return;
        const files = foldersByColumn[col] ?? {};
        resolved[col] = plan.dataRows.map((line) => {
          const r = resolveAttachmentNames(line[col] ?? "", files);
          for (const m of r.matched) pendingSources.add(m.sourcePath);
          return r;
        });
      });
      const relBySource = new Map<string, string>();
      await mapWithConcurrency([...pendingSources], 8, async (sourcePath) => {
        try {
          relBySource.set(sourcePath, await invoke<string>("save_asset", { sourcePath }));
        } catch (e) {
          logger.warn("csv-import.save_asset", "save_asset failed", sourcePath, e);
        }
      });

      const created = await store.addRows(plan.dataRows.length);
      const pasteDeps: PasteDeps = {
        latestField: (fieldId) => storeApi.getState().fields.find((f) => f.id === fieldId),
        createOption: (fieldId, name) => store.addSelectOption(fieldId, name),
      };
      const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
      const missingNames = new Set<string>();
      for (let ri = 0; ri < plan.dataRows.length; ri++) {
        const rowId = created[ri]?.id;
        if (!rowId) continue;
        const line = plan.dataRows[ri];
        for (let col = 0; col < colTargets.length; col++) {
          const field = colTargets[col];
          if (!field) continue;
          const raw = line[col] ?? "";
          if (raw.trim() === "") continue;
          if (field.field_type === "attachment") {
            const refs: AttachmentRef[] = [];
            for (const m of resolved[col][ri].matched) {
              const path = relBySource.get(m.sourcePath);
              if (path) refs.push({ name: m.name, path });
              else missingNames.add(m.name);
            }
            for (const name of resolved[col][ri].missing) missingNames.add(name);
            if (refs.length > 0) updates.push({ rowId, fieldId: field.id, value: refs });
            continue;
          }
          const pasted = await pasteCell(field, raw, pasteDeps);
          if (pasted) updates.push({ rowId, fieldId: field.id, value: pasted.value });
        }
      }
      await store.setCellsMany(updates);
      toast.success(t("csv.appended", { count: String(created.length) }));
      if (skippedCols > 0) toast.warning(t("csv.appendSkippedCols", { n: String(skippedCols) }));
      if (missingNames.size > 0) {
        const names = [...missingNames];
        const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` …(+${names.length - 5})` : "");
        toast.warning(t("csv.attachment.missingToast", { n: String(names.length), names: shown }));
      }
    } catch (e) {
      logger.error("csv append failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  /** 用户确认字段类型后执行真正的导入：建视图 → 建字段/行 → csv_import。
   *  附件列把「候选文件名」在所选文件夹索引里匹配，命中的先复制进 assets/ 再写单元格。 */
  const runImportCsv = async (
    types: FieldType[],
    foldersByColumn: Record<number, Record<string, string>>,
    target: "new" | "current",
  ) => {
    const plan = importPlan;
    setImportPlan(null);
    if (!plan) return;
    if (target === "current") {
      await runAppendCsv(foldersByColumn);
      return;
    }
    try {
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      if (!wsId) return;
      // 新表 = 新 grid 视图
      const newView = await viewApi.create({
        workspace_id: wsId,
        parent_id: null,
        name: plan.fileName,
        layout: "grid",
      });
      // 建字段（重名则加序号）—— 解析/类型推断/消歧/id 生成在 JS，落库由 csv_import 单命令完成
      // 选择列：按列值收集去重选项名 → 生成 options（名 → id），单元格按名转 id 存
      const used = new Set<string>();
      const selectIdMaps: Record<number, Map<string, string>> = {};
      const fields = plan.headers.map((header, i) => {
        let name = header;
        while (used.has(name)) name = name + " 2";
        used.add(name);
        if (isOptionBearing(types[i])) {
          const names = collectSelectNames(
            types[i],
            plan.dataRows.map((r) => r[i] ?? ""),
          );
          const { options, idByName } = buildSelectOptions(names);
          selectIdMaps[i] = idByName;
          return { id: newId(), name, field_type: types[i], options: JSON.stringify({ kind: "select", options }) };
        }
        return { id: newId(), name, field_type: types[i], options: null };
      });

      // 附件列：逐行解析候选名（纯函数），收集待复制文件（按源路径去重）
      const attachmentCols: number[] = [];
      fields.forEach((f, i) => {
        if (f.field_type === "attachment") attachmentCols.push(i);
      });
      const resolved: Record<number, { matched: { name: string; sourcePath: string }[]; missing: string[] }[]> = {};
      const pendingSources = new Set<string>();
      for (const col of attachmentCols) {
        const files = foldersByColumn[col] ?? {};
        resolved[col] = plan.dataRows.map((line) => {
          const r = resolveAttachmentNames(line[col] ?? "", files);
          for (const m of r.matched) pendingSources.add(m.sourcePath);
          return r;
        });
      }
      // 先按去重后的源路径各复制一次（有上限并发），缓存「源路径 → assets 相对路径」避免重复复制
      const relBySource = new Map<string, string>();
      await mapWithConcurrency([...pendingSources], 8, async (sourcePath) => {
        try {
          relBySource.set(sourcePath, await invoke<string>("save_asset", { sourcePath }));
        } catch (e) {
          // 单个文件复制失败只记日志，后续按未匹配处理，不中断整次导入
          logger.warn("csv-import.save_asset", "save_asset failed", sourcePath, e);
        }
      });

      const missingNames = new Set<string>();
      // 嵌套 payload 按 Rust 结构体声明的 snake_case 键传（同 mention_rebuild 契约）
      const rows = plan.dataRows.map((line, ri) => {
        const cells: { field_id: string; value: string }[] = [];
        for (let i = 0; i < fields.length; i++) {
          const raw = line[i] ?? "";
          if (raw.trim() === "") continue;
          if (fields[i].field_type === "attachment") {
            const refs: AttachmentRef[] = [];
            for (const m of resolved[i][ri].matched) {
              const path = relBySource.get(m.sourcePath);
              if (path) refs.push({ name: m.name, path });
              else missingNames.add(m.name);
            }
            for (const name of resolved[i][ri].missing) missingNames.add(name);
            if (refs.length === 0) continue;
            cells.push({ field_id: fields[i].id, value: JSON.stringify(refs) });
            continue;
          }
          const cell = importCell(fields[i].field_type, raw, selectIdMaps[i]);
          if (cell !== null) cells.push({ field_id: fields[i].id, value: JSON.stringify(cell) });
        }
        return { id: newId(), cells };
      });
      await invoke("csv_import", { viewId: newView.id, fields, rows });
      await useWorkspaceStore.getState().reload();
      useWorkspaceStore.getState().openView(newView.id);
      toast.success(t("csv.imported", { count: String(plan.dataRows.length) }));
      if (missingNames.size > 0) {
        const names = [...missingNames];
        const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` …(+${names.length - 5})` : "");
        toast.warning(t("csv.attachment.missingToast", { n: String(names.length), names: shown }));
      }
    } catch (e) {
      logger.error("csv import failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

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
    toggleRowChecked,
    setDeleteRowTarget,
    commitCell,
    setCursor,
    setEditing,
    pasteAnchorRef,
  };
  const renderRow = (row: DatabaseRow) => renderGridRow(row, rowCtx);

  // 线性条目渲染：组头 / 数据行 / 组小计（窗口化切片直接 map 它）
  const renderLine = (line: GridFlatLine) => {
    if (line.kind === "row") return renderRow(line.row);
    if (line.kind === "header")
      return (
        <GridGroupHeaderRow
          key={"hdr_" + line.key}
          label={line.label}
          count={line.count}
          collapsed={line.collapsed}
          onToggle={() => toggleGroup(line.key)}
          colSpan={visibleFields.length + 2}
        />
      );
    return (
      <GridSubtotalRow
        key={"sub_" + line.key}
        rowIds={line.rowIds}
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
                onClick={() => setCheckedRows(new Set())}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {/* 分组字段切换 */}
          {groupableFields.length > 0 && (
            <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700">
              <span className="text-neutral-500">{t("grid.groupBy")}:</span>
              <select
                className="bg-transparent text-xs outline-none"
                value={groupFieldId ?? ""}
                onChange={(e) => changeGroupField(e.target.value || null)}
              >
                <option value="">{t("grid.noGroup")}</option>
                {groupableFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => setRowTrashOpen(true)} title={t("row.trash")}>
            <Archive className="h-3.5 w-3.5" />
            {t("row.trash")}
          </Button>
          <HiddenColumnsMenu fields={fields} onShow={(id) => void store.toggleFieldHidden(id)} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilterOpen((v) => !v)}
            className={cn(filterOpen && "bg-brand-100 text-brand-600")}
          >
            <Filter className="h-3.5 w-3.5" />
            {t("filter.title")}
            {filters.length > 0 && (
              <span className="ml-1 rounded-full bg-brand-500 px-1.5 text-[10px] text-white">{filters.length}</span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSortOpen((v) => !v)}
            className={cn(sortOpen && "bg-brand-100 text-brand-600")}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {t("sort.title")}
            {sorts.length > 0 && (
              <span className="ml-1 rounded-full bg-brand-500 px-1.5 text-[10px] text-white">{sorts.length}</span>
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={importCsv}>
            <FileUp className="h-3.5 w-3.5" />
            {t("csv.import")}
          </Button>
          <Button variant="ghost" size="sm" onClick={exportCsv}>
            <Download className="h-3.5 w-3.5" />
            {t("csv.export")}
          </Button>
        </div>
      </div>

      {filterOpen && (
        <FilterBar
          fields={fields}
          filters={filters}
          mode={filterMode}
          onChange={store.setFilters}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {sortOpen && (
        <SortBar fields={fields} sorts={sorts} onChange={store.setSorts} onClose={() => setSortOpen(false)} />
      )}

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
          <thead>
            <tr>
              <th className="sticky left-0 z-[6] border-b border-r border-neutral-200 bg-neutral-100 px-2 text-[11px] font-normal text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                <button
                  className="mx-auto flex h-4 w-4 items-center justify-center rounded text-neutral-500 hover:text-brand-600 dark:text-neutral-400"
                  title={t("row.selectAll")}
                  onClick={toggleSelectAll}
                >
                  {allSelected ? (
                    <CheckSquare className="h-3.5 w-3.5 text-brand-600" />
                  ) : (
                    <Square className="h-3 w-3" />
                  )}
                </button>
              </th>
              {visibleFields.map((field) => {
                const sortIndex = sorts.findIndex((s) => s.field_id === field.id);
                const sort = sortIndex === -1 ? null : sorts[sortIndex];
                const isPrimary = field.id === primaryField?.id;
                return (
                  <th
                    key={field.id}
                    className={cn(
                      "group/head relative border-b border-r border-neutral-200 bg-neutral-100 px-1 dark:border-neutral-700 dark:bg-neutral-800",
                      // 冻结主列表头：z 高于正文 sticky 列
                      isPrimary && "sticky left-[44px] z-[6]",
                    )}
                  >
                    <div
                      draggable={field.id !== primaryField?.id}
                      onDragStart={() => {
                        if (field.id !== primaryField?.id) setDraggingField(field.id);
                      }}
                      onDragEnd={() => setDraggingField(null)}
                      onDragOver={(e) => {
                        if (draggingField && draggingField !== field.id && field.id !== primaryField?.id)
                          e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        onFieldDrop(field.id);
                      }}
                      className={cn(
                        "flex h-8 cursor-pointer items-center gap-1",
                        draggingField === field.id && "opacity-40",
                      )}
                      onClick={() => cycleSort(field.id)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenFor(field.id);
                      }}
                    >
                      <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-neutral-300 dark:text-neutral-600" />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-800 dark:text-neutral-100">
                        {field.name}
                      </span>
                      <span className="flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 text-[10px] text-brand-600 dark:text-brand-500">
                        {sort && (
                          <>
                            <span>{sort.dir === "asc" ? "↑" : "↓"}</span>
                            {sorts.length > 1 && (
                              <span className="text-[9px] text-neutral-400 dark:text-neutral-500">{sortIndex + 1}</span>
                            )}
                          </>
                        )}
                      </span>
                      <FieldMenu
                        fieldName={field.name}
                        fieldType={field.field_type}
                        hidden={field.is_hidden === 1}
                        primary={field.id === primaryField?.id}
                        open={menuOpenFor === field.id}
                        onOpenChange={(open) => {
                          setMenuOpenFor(open ? field.id : null);
                        }}
                        onRename={() => {
                          setMenuOpenFor(null);
                          setRenamingField(field.id);
                        }}
                        onChangeType={(type) => {
                          setMenuOpenFor(null);
                          void store.changeFieldType(field.id, type).then(() => {
                            // 改成关联/公式/汇总后必须配置才有意义，直接弹出字段设置
                            if (!needsFieldSettings(type)) return;
                            const next = storeApi.getState().fields.find((f) => f.id === field.id);
                            if (next) setOptionsEditorFor(next);
                          });
                        }}
                        onToggleHidden={() => {
                          setMenuOpenFor(null);
                          void store.toggleFieldHidden(field.id);
                        }}
                        onDelete={() => {
                          setMenuOpenFor(null);
                          void store.removeField(field.id);
                        }}
                        onOpenOptions={() => {
                          setMenuOpenFor(null);
                          setOptionsEditorFor(field);
                        }}
                      />
                    </div>
                    {/* 重命名输入 */}
                    {renamingField === field.id && (
                      <RenameInput
                        initial={field.name}
                        onCommit={(name) => {
                          setRenamingField(null);
                          if (name && name !== field.name) void store.renameField(field.id, name);
                        }}
                        onCancel={() => setRenamingField(null)}
                      />
                    )}
                    {/* 列宽拖拽手柄 */}
                    <div
                      data-testid={"resize-" + field.id}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-brand-500/60"
                      onMouseDown={(e) => startColumnResize(e, field.id, field.width)}
                    />
                  </th>
                );
              })}
              <th className="border-b border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
                <AddFieldButton onConfigure={setOptionsEditorFor} />
              </th>
            </tr>
          </thead>
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
