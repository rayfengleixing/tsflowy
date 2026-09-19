import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileUp,
  Filter,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDatabaseStore } from "@/stores/database";
import { useWorkspaceStore } from "@/stores/workspace";
import { viewApi, newId } from "@/lib/db";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { UNGROUPED, applyFilters, canGroupBy, groupRowsForGrid, sortRows, type SortSpec } from "@/lib/database-query";
import { aggregateValue, normalizeAggregate, type AggregateFn } from "@/lib/database-aggregate";
import { buildCsvExport, csvValueToCell, parseCsv, planImport } from "@/lib/csv";
import { computeFormula } from "@/lib/database-formula";
import { FieldMenu } from "./FieldMenu";
import { FieldOptionsEditor } from "./FieldOptionsEditor";
import { NewFieldDialog } from "./NewFieldDialog";
import { FilterBar } from "./FilterBar";
import { AggregateMenu } from "./AggregateMenu";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { CellEditorSlot, SelectChips } from "./editors";
import { RowDetailPanel } from "./RowDetail";
import { Button } from "@/components/ui/button";
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
  const store = useDatabaseStore();
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [renamingField, setRenamingField] = useState<string | null>(null);
  const [optionsEditorFor, setOptionsEditorFor] = useState<DatabaseField | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draggingField, setDraggingField] = useState<string | null>(null);
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [groupFieldId, setGroupFieldId] = useState<string | null>(() => readViewConfig(view).groupFieldId ?? null);
  const [aggregates, setAggregates] = useState<Record<string, AggregateFn>>(
    () => readViewConfig(view).aggregates ?? {},
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    store.load(view).catch((e) => logger.error("grid.load", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  // 列宽拖拽：拖拽期间直接改 <col> 宽度（纯 DOM，零重渲/零 IPC），mouseup 才落库一次
  const tableRef = useRef<HTMLTableElement | null>(null);
  const startColumnResize = (e: ReactMouseEvent, fieldId: string, startWidth: number) => {
    e.preventDefault();
    const col = tableRef.current?.querySelector<HTMLTableColElement>(`col[data-field-id="${fieldId}"]`);
    if (!col) return;
    const startX = e.clientX;
    const clamp = (w: number) => Math.max(60, Math.min(600, w));
    const onMove = (ev: MouseEvent) => {
      col.style.width = clamp(startWidth + ev.clientX - startX) + "px";
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const width = clamp(startWidth + ev.clientX - startX);
      void store.setFieldWidth(fieldId, width).catch((err: unknown) => {
        col.style.width = ""; // 落库失败：去掉本地预览宽度，回退 store 旧值
        console.error("set field width failed", err);
        toast.error(t("error.db", { message: String(err) }));
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  // 名称列（主列）：position 最小且不可隐藏，作为行详情入口
  const primaryField = visibleFields[0] ?? null;

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, cells, filters, fields, filterMode);
    return sortRows(filtered, cells, sorts);
  }, [rows, cells, filters, fields, filterMode, sorts]);

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
        console.error("set cell failed", e);
        toast.error(t("error.db", { message: String(e) }));
      }
    },

    [store],
  );

  const cycleSort = (fieldId: string) => {
    const current = sorts.find((s) => s.field_id === fieldId);
    const next: SortSpec[] = !current
      ? [{ field_id: fieldId, dir: "asc" }]
      : current.dir === "asc"
        ? [{ field_id: fieldId, dir: "desc" }]
        : [];
    store.setSorts(next);
  };

  const addRow = async () => {
    try {
      await store.addRow();
    } catch (e) {
      console.error("add row failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // 字段拖拽排序（主列固定首位，只在其它列之间排序）
  const onFieldDrop = (targetId: string) => {
    if (!draggingField || draggingField === targetId) return;
    if (draggingField === primaryField?.id || targetId === primaryField?.id) return;
    const sortable = visibleFields.filter((f) => f.id !== primaryField?.id).map((f) => f.id);
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
    const ids = displayRows.map((r) => r.id);
    const from = ids.indexOf(draggingRow);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void store.reorderRows(ids);
    setDraggingRow(null);
  };

  // CSV 导出（公式列在导出前注入算好的值）
  const exportCsv = async () => {
    try {
      const cellsWithFormula = { ...cells };
      for (const row of rows) {
        for (const f of fields) {
          if (f.field_type !== "formula") continue;
          const v = computeFormula(f, cells[row.id] ?? {}, fields);
          if (v !== null) {
            cellsWithFormula[row.id] = { ...(cellsWithFormula[row.id] ?? {}), [f.id]: v };
          }
        }
      }
      const content = buildCsvExport(fields, rows, cellsWithFormula);
      const target = await save({
        defaultPath: (source.name || "export").replace(/[\\/:*?"<>|]/g, "_") + ".csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!target) return;
      await invoke("write_text_file", { path: target, content });
      toast.success(t("csv.exported"));
    } catch (e) {
      console.error("csv export failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  // CSV 导入（新表）
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
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      if (!wsId) return;
      // 新表 = 新 grid 视图
      const fileName =
        selected
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.csv$/i, "") || "导入表";
      const newView = await viewApi.create({ workspace_id: wsId, parent_id: null, name: fileName, layout: "grid" });
      // 建字段（重名则加序号）—— 解析/类型推断/消歧/id 生成在 JS，落库由 csv_import 单命令完成
      const used = new Set<string>();
      const fields = headers.map((header, i) => {
        let name = header;
        while (used.has(name)) name = name + " 2";
        used.add(name);
        return { id: newId(), name, field_type: types[i] };
      });
      // 嵌套 payload 按 Rust 结构体声明的 snake_case 键传（同 mention_rebuild 契约）
      const rows = parsed.slice(1).map((line) => {
        const cells: { field_id: string; value: string }[] = [];
        for (let i = 0; i < fields.length; i++) {
          const raw = line[i] ?? "";
          if (raw.trim() === "") continue;
          const cell = csvValueToCell(fields[i].field_type, raw);
          if (cell !== null) cells.push({ field_id: fields[i].id, value: JSON.stringify(cell) });
        }
        return { id: newId(), cells };
      });
      await invoke("csv_import", { viewId: newView.id, fields, rows });
      await useWorkspaceStore.getState().reload();
      useWorkspaceStore.getState().openView(newView.id);
      toast.success(t("csv.imported", { count: String(parsed.length - 1) }));
    } catch (e) {
      console.error("csv import failed", e);
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
        focusRowId === row.id && ROW_FOCUS_CLASS,
      )}
    >
      <td className="sticky left-0 z-[5] border-b border-r border-neutral-200 bg-white px-2 text-center text-[11px] text-neutral-400 group-hover/row:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500 dark:group-hover/row:bg-neutral-800/60">
        <span className="flex items-center justify-center gap-1">
          <GripVertical className="h-3 w-3 cursor-grab text-neutral-200 group-hover/row:text-neutral-400 dark:text-neutral-700 dark:group-hover/row:text-neutral-500" />
          {row.position + 1}
        </span>
        <button
          className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-red-100 hover:text-red-500 group-hover/row:flex dark:hover:bg-red-500/10"
          title={t("row.delete")}
          onClick={() => void store.removeRow(row.id)}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </td>
      {visibleFields.map((field) => {
        const isPrimary = field.id === primaryField?.id;
        const isEditing = editing?.rowId === row.id && editing.fieldId === field.id;
        // 公式字段无存储值：渲染时按表达式实时计算
        const value =
          field.field_type === "formula"
            ? computeFormula(field, cells[row.id] ?? {}, fields)
            : (cells[row.id]?.[field.id] ?? null);
        return (
          <td
            key={field.id}
            className={cn(
              "relative h-8 border-b border-r border-neutral-200 p-0 align-middle dark:border-neutral-700",
              isEditing && "z-10 ring-1 ring-inset ring-brand-500 dark:ring-brand-500",
              // 冻结主列：跟随序号列（44px）右侧
              isPrimary && "sticky left-[44px] z-[5] bg-white dark:bg-neutral-900",
              isPrimary && "cursor-pointer",
            )}
            onClick={() => {
              if (isPrimary) {
                // 名称列：单击编辑值（编辑框后的"打开"图标/双击打开所属页面）
                setEditing({ rowId: row.id, fieldId: field.id });
                return;
              }
              if (isReadonlyType(field.field_type) || isEditing) return;
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
                    onAddOption={(name) => {
                      void store.addSelectOption(field.id, name);
                      return null;
                    }}
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

  /** 分组小计行：只铺已配置汇总的列，其余列留空 */
  const renderSubtotal = (groupRows: DatabaseRow[]) => {
    const rowIds = groupRows.map((r) => r.id);
    return (
      <tr className="bg-neutral-50/80 dark:bg-neutral-900/40">
        <td className="border-b border-r border-neutral-200 px-1 text-right text-[11px] text-neutral-400 dark:border-neutral-700">
          {t("grid.subtotal")}
        </td>
        {visibleFields.map((field) => {
          const fn = aggregateOf(field);
          return (
            <td
              key={field.id}
              className="h-7 border-b border-r border-neutral-200 px-2 align-middle text-[11px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              {fn ? aggregateValue(fn, field, rowIds, cells) : null}
            </td>
          );
        })}
        <td className="border-b border-neutral-200 dark:border-neutral-700" />
      </tr>
    );
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

      {/* 表格（横向滚动） */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
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
                #
              </th>
              {visibleFields.map((field) => {
                const sort = sorts.find((s) => s.field_id === field.id);
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
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] text-brand-600 dark:text-brand-500">
                        {sort ? (sort.dir === "asc" ? "↑" : "↓") : ""}
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
                          void store.changeFieldType(field.id, type);
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
                <AddFieldButton />
              </th>
            </tr>
          </thead>
          <tbody>
            {groups
              ? groups.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  return (
                    <Fragment key={group.key}>
                      <tr>
                        <td
                          colSpan={visibleFields.length + 2}
                          className="border-b border-neutral-200 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900/40"
                        >
                          <button
                            className="flex items-center gap-1.5 text-[12px] font-medium text-neutral-700 dark:text-neutral-200"
                            onClick={() => toggleGroup(group.key)}
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span className="truncate">
                              {group.key === UNGROUPED || !group.label ? t("grid.ungrouped") : group.label}
                            </span>
                            <span className="text-[11px] font-normal text-neutral-400">{group.rows.length}</span>
                          </button>
                        </td>
                      </tr>
                      {!collapsed && group.rows.map(renderRow)}
                      {!collapsed && hasAggregates && renderSubtotal(group.rows)}
                    </Fragment>
                  );
                })
              : displayRows.map(renderRow)}
            <tr>
              {/* 新建行：跨整行底部，避免无字段时挤在窄列里 */}
              <td
                colSpan={1 + visibleFields.length + 1}
                className="h-8 border-t border-neutral-200 px-2 dark:border-neutral-700"
              >
                <button
                  data-testid="add-row"
                  className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  onClick={addRow}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("row.new")}
                </button>
              </td>
            </tr>
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
                      rowIds={displayRows.map((r) => r.id)}
                      cells={cells}
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

      {/* 行详情右侧滑出面板（说明书 6.1：宽 400px） */}
      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}

function RenameInput(props: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(props.initial);
  return (
    <input
      autoFocus
      className="absolute inset-x-1 top-1/2 h-6 -translate-y-1/2 rounded border border-brand-500 bg-white px-1.5 text-[12px] outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onCommit(draft);
        if (e.key === "Escape") props.onCancel();
      }}
      onBlur={() => props.onCommit(draft)}
    />
  );
}

function AddFieldButton() {
  const store = useDatabaseStore();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        data-testid="add-field"
        className="flex h-8 w-8 items-center justify-center text-neutral-500 hover:bg-neutral-300/50"
        title={t("field.new")}
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4" />
      </button>
      <NewFieldDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (name, type) => {
          try {
            await store.addField(type, name);
            setOpen(false);
          } catch (e) {
            console.error("add field failed", e);
            toast.error(t("error.db", { message: String(e) }));
          }
        }}
      />
    </>
  );
}

/** 单元格显示（非编辑态） */
function CellDisplay({
  field,
  value,
  primary = false,
  onChipRemove,
  onOpenRowDetail,
}: {
  field: DatabaseField;
  value: CellValue;
  primary?: boolean;
  onChipRemove?: (newValue: CellValue) => void;
  onOpenRowDetail?: () => void;
}) {
  const opts = parseFieldOptions(field.options);
  if (field.field_type === "checkbox") {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-brand-600">
        {value === true ? "✓" : ""}
      </div>
    );
  }
  if (field.field_type === "single_select" || field.field_type === "multi_select") {
    return (
      <div className="flex h-full w-full items-center truncate px-2">
        {Array.isArray(value) && value.length === 0 ? (
          <span className="text-neutral-300" />
        ) : (
          <SelectChips field={field} value={value} onRemove={onChipRemove} />
        )}
      </div>
    );
  }
  const text = formatCellValue(field.field_type, value, opts);
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-1 truncate px-2 text-[13px] leading-8",
        isReadonlyType(field.field_type) && "text-neutral-400",
        primary && "font-medium text-neutral-900",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {primary && onOpenRowDetail && (
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-brand-600"
          title={t("row.openDetail")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenRowDetail();
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
