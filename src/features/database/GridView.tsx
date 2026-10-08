import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowUpDown,
  CheckSquare,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Filter,
  GripVertical,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { AttachmentRef, CellValue, DatabaseField, DatabaseRow, FieldType } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDbStore, useDbStoreApi } from "@/stores/database-context";
import { useWorkspaceStore } from "@/stores/workspace";
import { viewApi, newId } from "@/lib/db";
import { parseFieldOptions } from "@/lib/database-values";
import { UNGROUPED, applyFilters, canGroupBy, groupRowsForGrid, sortRows, type SortSpec } from "@/lib/database-query";
import { normalizeAggregate, type AggregateFn } from "@/lib/database-aggregate";
import {
  buildCsvExport,
  csvValueToCell,
  parseCsv,
  planImport,
  parseTsv,
  resolveAttachmentNames,
  resolveSelectRefs,
} from "@/lib/csv";
import { CsvImportDialog } from "./CsvImportDialog";
import { computeFormula } from "@/lib/database-formula";
import {
  computeReverseRelation,
  computeRollup,
  relationRowIds,
  relationRowLabel,
  relationTarget,
} from "@/lib/relation";
import { useRelationDbs } from "./use-database-data";
import { FieldMenu } from "./FieldMenu";
import { FieldOptionsEditor } from "./FieldOptionsEditor";
import { FilterBar } from "./FilterBar";
import { SortBar } from "./SortBar";
import { AggregateMenu } from "./AggregateMenu";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { CellEditorSlot } from "./editors";
import { RowDetailPanel } from "./RowDetail";
import { AddFieldButton, CellDisplay, HiddenColumnsMenu, RenameInput, needsFieldSettings } from "./grid-parts";
import { GridAddRow, GridGroupHeaderRow, GridSpacerRow, GridSubtotalRow } from "./grid-rows";
import {
  ROW_H_FALLBACK,
  VIRTUAL_MIN_ROWS,
  VIRTUAL_OVERSCAN,
  cellSelector,
  clampColumnWidth,
  computeEvaluatedCells,
  computeVirtualWindow,
  rowCenterScrollTop,
} from "./grid-view-helpers";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";

import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import type { View } from "@/types/models";

/** 有并发上限的异步遍历：附件列复制时避免 N 行 × M 个附件同时发起 save_asset 打爆磁盘 I/O */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

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
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [renamingField, setRenamingField] = useState<string | null>(null);
  const [optionsEditorFor, setOptionsEditorFor] = useState<DatabaseField | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // 待确认删除的行（行删除不可撤销，先确认再落库）
  const [deleteRowTarget, setDeleteRowTarget] = useState<DatabaseRow | null>(null);
  // 多选行（序号列勾选框）：键为 rowId；实际生效集合每次按可见行求交，行被删/被筛走都不会残留
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
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
    store.load(view).catch((e) => logger.error("grid.load", e));
    setCheckedRows(new Set());
    setCursor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  // 名称列（主列）：position 最小且不可隐藏，作为行详情入口
  const primaryField = visibleFields[0] ?? null;

  // 关联/汇总要读目标库：把本表所有关联字段的目标视图拉进缓存（同一目标库只请求一次）
  const relationDbOf = useRelationDbs(fields);

  // 公式/汇总字段没有存储值：把求值结果提前算进一份"有效单元格"图，排序/列汇总/分组小计都读它，
  // 否则按这两列排序排不动（raw 恒为空值）、汇总恒为空。没有这类字段时直接复用原始 cells。
  const evaluatedCells = useMemo(
    () => computeEvaluatedCells(rows, cells, fields, relationDbOf),
    [rows, cells, fields, relationDbOf],
  );

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, cells, filters, fields, filterMode);
    return sortRows(filtered, evaluatedCells, sorts);
  }, [rows, cells, evaluatedCells, filters, fields, filterMode, sorts]);

  // 底部汇总菜单的 rowIds：每次渲染都新建数组会让菜单里的 useMemo 全部失效
  const displayRowIds = useMemo(() => displayRows.map((r) => r.id), [displayRows]);

  // 多选：只认当前可见（筛选 + 排序后）且仍存在的行
  const selectedIds = useMemo(
    () => displayRows.filter((r) => checkedRows.has(r.id)).map((r) => r.id),
    [displayRows, checkedRows],
  );
  const allSelected = displayRows.length > 0 && selectedIds.length === displayRows.length;

  const toggleRowChecked = (rowId: string) => {
    setCheckedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setCheckedRows(allSelected ? new Set() : new Set(displayRows.map((r) => r.id)));
  };

  const deleteSelected = async () => {
    const ids = selectedIds;
    if (ids.length === 0) return;
    try {
      const n = await store.removeRows(ids);
      setCheckedRows(new Set());
      toast.success(t("row.deletedMany", { count: String(n) }));
    } catch (e) {
      logger.error("delete rows failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const duplicateSelected = async () => {
    const ids = selectedIds;
    if (ids.length === 0) return;
    try {
      const created = await store.duplicateRows(ids);
      setCheckedRows(new Set());
      toast.success(t("row.duplicated", { count: String(created.length) }));
    } catch (e) {
      logger.error("duplicate rows failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // 分组字段被删除或改成不可分组的类型时，自动回落成不分组（配置留着，改回来还在）
  const groupField = useMemo(
    () => fields.find((f) => f.id === groupFieldId && canGroupBy(f)) ?? null,
    [fields, groupFieldId],
  );
  const groupableFields = useMemo(() => visibleFields.filter(canGroupBy), [visibleFields]);
  const groups = useMemo(
    () => (groupField ? groupRowsForGrid(displayRows, cells, groupField) : null),
    [groupField, displayRows, cells],
  );

  // 搜索命中定位：折叠键作 revision，命中行所在分组一展开就能重新定位
  const collapsedKey = groups ? [...collapsedGroups].join("|") : "";
  const { scrollerRef, focusRowId } = useRowFocus(collapsedKey);

  // ---------- 大表窗口化 ----------
  // 行高固定（td h-8），行数超阈值时只渲染视口附近的行，上下用占位行撑住滚动条；
  // 阈值以下走原路径，小表零行为变化。分组视图不窗口化（组头/小计参与纵向布局）。
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const rowHeightRef = useRef(ROW_H_FALLBACK);
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const virtual = !groups && displayRows.length > VIRTUAL_MIN_ROWS;

  // 量出"数据区在滚动内容里的 y 偏移"再折算窗口：表头高度随缩放/字体变化，写死常量会越滚越偏
  const measureWindow = useCallback(() => {
    const el = scrollerRef.current;
    const body = tbodyRef.current;
    if (!el || !body) return;
    const first = body.querySelector<HTMLElement>("tr[data-row-id]");
    if (first?.offsetHeight) rowHeightRef.current = first.offsetHeight;
    const h = rowHeightRef.current;
    const dataTop = body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const next = computeVirtualWindow({
      scrollTop: el.scrollTop,
      dataTop,
      clientHeight: el.clientHeight,
      total: displayRows.length,
      rowHeight: h,
    });
    setWin((prev) => (prev?.start === next.start && prev.end === next.end ? prev : next));
  }, [scrollerRef, displayRows.length]);

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

  // 命中行在窗口外时先滚过去，等下一帧 useRowFocus 的 DOM 查询才找得到它
  useEffect(() => {
    if (!focusRowId || !virtual) return;
    const idx = displayRows.findIndex((r) => r.id === focusRowId);
    const el = scrollerRef.current;
    const body = tbodyRef.current;
    if (idx < 0 || !el || !body) return;
    if (win && idx >= win.start && idx < win.end) return;
    const dataTop = body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = rowCenterScrollTop({
      dataTop,
      index: idx,
      rowHeight: rowHeightRef.current,
      clientHeight: el.clientHeight,
    });
  }, [focusRowId, virtual, displayRows, win, scrollerRef]);

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

  // 字段类型可能已经变了：历史选择不在候选里就回落成计数
  const aggregateOf = (field: DatabaseField) => normalizeAggregate(field.field_type, aggregates[field.id]);
  const hasAggregates = visibleFields.some((f) => aggregateOf(f));

  // ---------- 键盘导航 ----------
  /** 光标移动：越界即夹紧；虚拟窗口外的行先滚过去，渲染完成后再聚焦 */
  const moveCursorTo = (rowIndex: number, colIndex: number) => {
    const ri = Math.max(0, Math.min(displayRows.length - 1, rowIndex));
    const ci = Math.max(0, Math.min(visibleFields.length - 1, colIndex));
    if (displayRows.length === 0 || visibleFields.length === 0) return;
    const row = displayRows[ri];
    const field = visibleFields[ci];
    if (virtual && (ri < (win?.start ?? 0) || ri >= (win?.end ?? Infinity))) {
      const el = scrollerRef.current;
      const body = tbodyRef.current;
      if (el && body) {
        const dataTop = body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        el.scrollTop = rowCenterScrollTop({
          dataTop,
          index: ri,
          rowHeight: rowHeightRef.current,
          clientHeight: el.clientHeight,
        });
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
    void store.reorderFields([primaryField?.id, ...sortable].filter(Boolean));
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
      const cellsWithFormula = { ...cells };
      for (const row of displayRows) {
        const rowCells = cells[row.id] ?? {};
        for (const f of fields) {
          if (f.field_type === "formula") {
            const v = computeFormula(f, rowCells, fields);
            if (v !== null) {
              cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: v };
            }
          } else if (f.field_type === "rollup") {
            const v = computeRollup(f, rowCells, fields, relationDbOf);
            if (v !== null) {
              cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: v };
            }
          } else if (f.field_type === "relation") {
            // 导出成行标题而不是行 id：导出的 CSV 才对人可读
            const db = relationDbOf(relationTarget(f) ?? "");
            const text = relationRowIds(rowCells[f.id] ?? null)
              .map((id) => (db ? relationRowLabel(db, id) : null) ?? id)
              .join("; ");
            cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: text };
          } else if (f.field_type === "reverse_relation") {
            // 反向关系无存储值：实时反查来源行并导出标题（同样对人可读）
            const ids = computeReverseRelation(row.id, f, relationDbOf) ?? [];
            const cfg = parseFieldOptions(f.options);
            const db = cfg.kind === "reverse_relation" ? relationDbOf(cfg.source_view_id) : undefined;
            const text = ids.map((id) => (db ? relationRowLabel(db, id) : null) ?? id).join("; ");
            if (text !== "") cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: text };
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
      const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const field = visibleFields[startCol + j];
          if (!field) {
            skipped++; // 超出最右列
            continue;
          }
          if (
            isReadonlyType(field.field_type) ||
            field.field_type === "relation" ||
            field.field_type === "attachment"
          ) {
            skipped++; // 公式/汇总/系统字段、关联字段与附件字段跳过（粘贴的文本无法直接对应行 id / 文件）
            continue;
          }
          if (field.field_type === "single_select" || field.field_type === "multi_select") {
            // 选择类单元格存选项 id：按名字解析，缺的选项就地补建（导出侧把 id 翻回名字，两边闭环）
            // 每格都取 store 最新字段：上一格补建的选项要参与下一格的解析，避免同名重复建选项
            const fresh = storeApi.getState().fields.find((f) => f.id === field.id) ?? field;
            const opts = parseFieldOptions(fresh.options);
            if (opts.kind !== "select") {
              skipped++;
              continue;
            }
            const { ids, missing } = resolveSelectRefs(field.field_type, grid[i][j], opts.options);
            for (const name of missing) {
              const created = await store.addSelectOption(field.id, name);
              if (created) ids.push(created);
              else skipped++;
            }
            updates.push({
              rowId: rowQueue[i],
              fieldId: field.id,
              value: field.field_type === "multi_select" ? ids : (ids[0] ?? null),
            });
            continue;
          }
          updates.push({
            rowId: rowQueue[i],
            fieldId: field.id,
            value: csvValueToCell(field.field_type, grid[i][j]),
          });
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

  /** 用户确认字段类型后执行真正的导入：建视图 → 建字段/行 → csv_import。
   *  附件列把「候选文件名」在所选文件夹索引里匹配，命中的先复制进 assets/ 再写单元格。 */
  const runImportCsv = async (types: FieldType[], foldersByColumn: Record<number, Record<string, string>>) => {
    const plan = importPlan;
    setImportPlan(null);
    if (!plan) return;
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
      const used = new Set<string>();
      const fields = plan.headers.map((header, i) => {
        let name = header;
        while (used.has(name)) name = name + " 2";
        used.add(name);
        return { id: newId(), name, field_type: types[i] };
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
          const cell = csvValueToCell(fields[i].field_type, raw);
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
  const renderRow = (row: DatabaseRow) => (
    <tr
      key={row.id}
      data-row-id={row.id}
      draggable
      onDragStart={() => setDraggingRow(row.id)}
      onDragEnd={() => setDraggingRow(null)}
      onDragOver={(e) => {
        if (draggingRow && draggingRow !== row.id) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onRowDrop(row.id);
      }}
      className={cn(
        "group/row hover:bg-neutral-100 dark:hover:bg-neutral-800/60",
        draggingRow === row.id && "opacity-40",
        checkedRows.has(row.id) && "bg-brand-50/70 dark:bg-brand-500/10",
        focusRowId === row.id && ROW_FOCUS_CLASS,
      )}
    >
      <td className="sticky left-0 z-[5] border-b border-r border-neutral-200 bg-white px-2 text-center text-[11px] text-neutral-400 group-hover/row:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500 dark:group-hover/row:bg-neutral-800/60">
        <span className="flex items-center justify-center gap-1">
          {/* icon 区域固定 16px 宽：消除 GripVertical(12px) → Square/CheckSquare(16px) 的占位跳动 */}
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {checkedRows.has(row.id) ? (
              <button
                className="flex h-4 w-4 items-center justify-center rounded text-brand-600 hover:bg-brand-100 dark:hover:bg-brand-500/10"
                title={t("row.select")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRowChecked(row.id);
                }}
              >
                <CheckSquare className="h-3.5 w-3.5" />
              </button>
            ) : (
              <>
                <button
                  className="hidden h-4 w-4 items-center justify-center rounded text-neutral-300 hover:text-brand-600 group-hover/row:flex dark:text-neutral-600"
                  title={t("row.select")}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRowChecked(row.id);
                  }}
                >
                  <Square className="h-3 w-3" />
                </button>
                <GripVertical className="h-3 w-3 cursor-grab text-neutral-200 group-hover/row:hidden dark:text-neutral-700" />
              </>
            )}
          </span>
          {/* 序号等宽数字 + 固定宽度：防止 1(窄) vs 0/2-9(宽) 及位数变化导致的列宽抖动 */}
          <span className="tabular-nums w-5 shrink-0 text-center">{row.position + 1}</span>
        </span>
        <button
          className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-red-100 hover:text-red-500 group-hover/row:flex dark:hover:bg-red-500/10"
          title={t("row.delete")}
          onClick={() => setDeleteRowTarget(row)}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </td>
      {visibleFields.map((field) => {
        const isPrimary = field.id === primaryField?.id;
        const isEditing = editing?.rowId === row.id && editing.fieldId === field.id;
        // 公式/汇总/反向关系字段无存储值：渲染时按表达式/关联行/来源行实时计算
        const value =
          field.field_type === "formula"
            ? computeFormula(field, cells[row.id] ?? {}, fields)
            : field.field_type === "rollup"
              ? computeRollup(field, cells[row.id] ?? {}, fields, relationDbOf)
              : field.field_type === "reverse_relation"
                ? computeReverseRelation(row.id, field, relationDbOf)
                : (cells[row.id]?.[field.id] ?? null);
        return (
          <td
            key={field.id}
            data-cell-row={row.id}
            data-cell-field={field.id}
            tabIndex={-1}
            className={cn(
              "relative h-8 border-b border-r border-neutral-200 p-0 align-middle outline-none dark:border-neutral-700",
              isEditing && "z-10 ring-1 ring-inset ring-brand-500 dark:ring-brand-500",
              !isEditing && "focus:z-10 focus:ring-1 focus:ring-inset focus:ring-brand-500",
              // 冻结主列：跟随序号列（44px）右侧
              isPrimary && "sticky left-[44px] z-[5] bg-white dark:bg-neutral-900",
              isPrimary && "cursor-pointer",
            )}
            onClick={() => {
              if (isPrimary) {
                // 名称列：单击编辑值（编辑框后的"打开"图标/双击打开所属页面）
                setCursor({ rowId: row.id, fieldId: field.id });
                setEditing({ rowId: row.id, fieldId: field.id });
                pasteAnchorRef.current = { rowId: row.id, fieldId: field.id };
                return;
              }
              // TSV 粘贴锚点与键盘光标：任何可编辑格都记录
              if (!isReadonlyType(field.field_type)) pasteAnchorRef.current = { rowId: row.id, fieldId: field.id };
              if (isReadonlyType(field.field_type) || isEditing) return;
              setCursor({ rowId: row.id, fieldId: field.id });
              if (field.field_type === "checkbox") {
                // 复选框：单击直接切换勾选
                void commitCell(row.id, field.id, cells[row.id]?.[field.id] !== true);
                return;
              }
              setEditing({ rowId: row.id, fieldId: field.id });
            }}
          >
            {isEditing ? (
              <div className="flex h-full items-center pr-1">
                <div className="min-w-0 flex-1">
                  <CellEditorSlot
                    field={field}
                    value={cells[row.id]?.[field.id] ?? null}
                    onCommit={(v) => void commitCell(row.id, field.id, v)}
                    onCancel={() => setEditing(null)}
                    onAddOption={(name) => store.addSelectOption(field.id, name)}
                    onDeleteOption={(optId) => void store.removeSelectOption(field.id, optId)}
                  />
                </div>
                {isPrimary && (
                  <button
                    type="button"
                    className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-brand-600"
                    title={t("row.openDetail")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(null);
                      void openRowDetail(row, source);
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <CellDisplay
                field={field}
                value={value}
                primary={isPrimary}
                onChipRemove={(newVal) => void store.setCell(row.id, field.id, newVal)}
                onOpenRowDetail={() => void openRowDetail(row, source)}
              />
            )}
          </td>
        );
      })}
      <td className="border-b border-neutral-200 dark:border-neutral-700" />
    </tr>
  );

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
              <Button variant="ghost" size="sm" onClick={duplicateSelected}>
                <Copy className="h-3.5 w-3.5" />
                {t("row.duplicateSelected")}
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
            {groups
              ? groups.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  return (
                    <Fragment key={group.key}>
                      <GridGroupHeaderRow
                        label={group.key === UNGROUPED || !group.label ? t("grid.ungrouped") : group.label}
                        count={group.rows.length}
                        collapsed={collapsed}
                        onToggle={() => toggleGroup(group.key)}
                        colSpan={visibleFields.length + 2}
                      />
                      {!collapsed && group.rows.map(renderRow)}
                      {!collapsed && hasAggregates && (
                        <GridSubtotalRow
                          rowIds={group.rows.map((r) => r.id)}
                          visibleFields={visibleFields}
                          aggregateOf={aggregateOf}
                          cells={evaluatedCells}
                        />
                      )}
                    </Fragment>
                  );
                })
              : virtual
                ? (() => {
                    // 首次 commit 还没量过窗口：先渲染开头一段，effect 量完立刻纠正
                    const start = win?.start ?? 0;
                    const end = win?.end ?? Math.min(displayRows.length, VIRTUAL_OVERSCAN * 4);
                    return (
                      <>
                        {start > 0 && (
                          <GridSpacerRow height={start * rowHeightRef.current} colSpan={visibleFields.length + 2} />
                        )}
                        {displayRows.slice(start, end).map(renderRow)}
                        {end < displayRows.length && (
                          <GridSpacerRow
                            height={(displayRows.length - end) * rowHeightRef.current}
                            colSpan={visibleFields.length + 2}
                          />
                        )}
                      </>
                    );
                  })()
                : displayRows.map(renderRow)}
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
                      cells={evaluatedCells}
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
        onConfirm={() => void deleteSelected()}
      />

      {/* CSV 导入确认：逐列选类型 + 附件列选文件夹（取消则不建视图） */}
      {importPlan && (
        <CsvImportDialog
          headers={importPlan.headers}
          initialTypes={importPlan.types}
          dataRows={importPlan.dataRows}
          onCancel={() => setImportPlan(null)}
          onConfirm={(types, foldersByColumn) => void runImportCsv(types, foldersByColumn)}
        />
      )}

      {/* 行详情右侧滑出面板（说明书 6.1：宽 400px） */}
      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}
