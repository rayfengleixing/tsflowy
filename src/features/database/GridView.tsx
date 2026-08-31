import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileUp, Filter, GripVertical, Plus, Trash2 } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { CellValue, DatabaseField, FieldType } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDatabaseStore } from "@/stores/database";
import { useWorkspaceStore } from "@/stores/workspace";
import { viewApi } from "@/lib/db";
import { databaseApi } from "@/lib/database";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { applyFilters, sortRows, type SortSpec } from "@/lib/database-query";
import { buildCsvExport, csvValueToCell, parseCsv, planImport } from "@/lib/csv";
import { viewIcon } from "@/components/view-icon";
import { FieldMenu } from "./FieldMenu";
import { FieldOptionsEditor } from "./FieldOptionsEditor";
import { FilterBar } from "./FilterBar";
import { CheckboxCellEditor, DateCellEditor, MultiSelectCellEditor, NumberCellEditor, SelectCellEditor, TextCellEditor } from "./editors";
import { RowDetailPanel } from "./RowDetail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

/** Grid 数据库视图（说明书 10-M4）：表头 32px / 行 32px / 单元格聚焦蓝框（6.6 节） */
export function GridView({ view }: { view: View }) {
  const store = useDatabaseStore();
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [renamingField, setRenamingField] = useState<string | null>(null);
  const [optionsEditorFor, setOptionsEditorFor] = useState<DatabaseField | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draggingField, setDraggingField] = useState<string | null>(null);
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [resizingField, setResizingField] = useState<string | null>(null);

  useEffect(() => {
    store.load(view.id).catch((e) => console.error("grid load failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  // 列宽拖拽
  useEffect(() => {
    if (!resizingField) return;
    const onMove = (e: MouseEvent) => {
      const field = store.fields.find((f) => f.id === resizingField);
      if (!field) return;
      const width = Math.max(60, Math.min(600, field.width + e.movementX));
      void store.setFieldWidth(resizingField, width);
    };
    const onUp = () => setResizingField(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizingField]);

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, cells, filters, fields, filterMode);
    return sortRows(filtered, cells, sorts);
  }, [rows, cells, filters, fields, filterMode, sorts]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );

  const cycleSort = (fieldId: string) => {
    const current = sorts.find((s) => s.field_id === fieldId);
    const next: SortSpec[] =
      !current
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

  // 字段拖拽排序
  const onFieldDrop = (targetId: string) => {
    if (!draggingField || draggingField === targetId) return;
    const ids = visibleFields.map((f) => f.id);
    const from = ids.indexOf(draggingField);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void store.reorderFields(ids);
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

  // CSV 导出
  const exportCsv = async () => {
    try {
      const content = buildCsvExport(fields, rows, cells);
      const target = await save({
        defaultPath: (view.name || "export").replace(/[\\/:*?"<>|]/g, "_") + ".csv",
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
      const fileName = selected.split(/[\\/]/).pop()?.replace(/\.csv$/i, "") || "导入表";
      const newView = await viewApi.create({ workspace_id: wsId, parent_id: null, name: fileName, layout: "grid" });
      // 建字段（重名则加序号）
      const used = new Set<string>();
      const createdFields: DatabaseField[] = [];
      for (let i = 0; i < headers.length; i++) {
        let name = headers[i];
        while (used.has(name)) name = name + " 2";
        used.add(name);
        createdFields.push(await databaseApi.createField(newView.id, types[i], name));
      }
      // 建行写单元格
      for (const line of parsed.slice(1)) {
        const row = await databaseApi.createRow(newView.id);
        for (let i = 0; i < createdFields.length; i++) {
          const raw = line[i] ?? "";
          if (raw.trim() === "") continue;
          const field = createdFields[i];
          const cell = csvValueToCell(field.field_type, raw);
          if (cell !== null) await databaseApi.setCell(row.id, field.id, cell);
        }
      }
      await useWorkspaceStore.getState().reload();
      useWorkspaceStore.getState().openView(newView.id);
      toast.success(t("csv.imported", { count: String(parsed.length - 1) }));
    } catch (e) {
      console.error("csv import failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏标题行（说明书 6.2：高 44px） */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <span className="text-lg leading-none">{viewIcon(view)}</span>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium text-neutral-800">{view.name}</h1>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setFilterOpen((v) => !v)} className={cn(filterOpen && "bg-brand-100 text-brand-600")}>
            <Filter className="h-3.5 w-3.5" />
            {t("filter.title")}
            {filters.length > 0 && <span className="ml-1 rounded-full bg-brand-500 px-1.5 text-[10px] text-white">{filters.length}</span>}
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
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: 44 }} />
            {visibleFields.map((f) => (
              <col key={f.id} style={{ width: f.width }} />
            ))}
            <col style={{ width: 44 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="border-b border-r border-neutral-300 bg-neutral-200/70 px-2 text-[11px] font-normal text-neutral-500">
                #
              </th>
              {visibleFields.map((field) => {
                const sort = sorts.find((s) => s.field_id === field.id);
                return (
                  <th key={field.id} className="group/head relative border-b border-r border-neutral-300 bg-neutral-200/70 px-1">
                    <div
                      draggable
                      onDragStart={() => setDraggingField(field.id)}
                      onDragEnd={() => setDraggingField(null)}
                      onDragOver={(e) => {
                        if (draggingField && draggingField !== field.id) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        onFieldDrop(field.id);
                      }}
                      className={cn("flex h-8 cursor-pointer items-center gap-1", draggingField === field.id && "opacity-40")}
                      onClick={() => cycleSort(field.id)}
                    >
                      <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-neutral-300" />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-800">{field.name}</span>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] text-brand-600">
                        {sort ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                      </span>
                      <FieldMenu
                        fieldName={field.name}
                        fieldType={field.field_type}
                        hidden={field.is_hidden === 1}
                        onRename={() => setRenamingField(field.id)}
                        onChangeType={(type) => void store.changeFieldType(field.id, type)}
                        onToggleHidden={() => void store.toggleFieldHidden(field.id)}
                        onDelete={() => void store.removeField(field.id)}
                        onOpenOptions={() => setOptionsEditorFor(field)}
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
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setResizingField(field.id);
                      }}
                    />
                  </th>
                );
              })}
              <th className="border-b border-neutral-300 bg-neutral-200/70">
                <AddFieldButton />
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr
                key={row.id}
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
                className={cn("group/row hover:bg-neutral-100/80", draggingRow === row.id && "opacity-40")}
                onDoubleClick={() => void openRowDetail(row, view)}
              >
                <td className="relative border-b border-r border-neutral-200 px-2 text-center text-[11px] text-neutral-400">
                  <span className="flex items-center justify-center gap-1">
                    <GripVertical className="h-3 w-3 cursor-grab text-neutral-200 group-hover/row:text-neutral-400" />
                    {row.position + 1}
                  </span>
                  <button
                    className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-red-100 hover:text-red-500 group-hover/row:flex"
                    title={t("row.delete")}
                    onClick={() => void store.removeRow(row.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
                {visibleFields.map((field) => {
                  const isEditing = editing?.rowId === row.id && editing.fieldId === field.id;
                  return (
                    <td
                      key={field.id}
                      className={cn(
                        "relative h-8 border-b border-r border-neutral-200 p-0 align-middle",
                        isEditing && "ring-1 ring-inset ring-brand-500",
                      )}
                      onClick={() => {
                        if (isReadonlyType(field.field_type) || isEditing) return;
                        setEditing({ rowId: row.id, fieldId: field.id });
                      }}
                    >
                      {isEditing ? (
                        <CellEditorSlot
                          field={field}
                          value={cells[row.id]?.[field.id] ?? null}
                          onCommit={(v) => void commitCell(row.id, field.id, v)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <CellDisplay field={field} value={cells[row.id]?.[field.id] ?? null} />
                      )}
                    </td>
                  );
                })}
                <td className="border-b border-neutral-200" />
              </tr>
            ))}
            <tr>
              <td className="h-8 border-r border-neutral-200" />
              <td className="h-8 border-r border-neutral-200 px-2">
                <button
                  data-testid="add-row"
                  className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-neutral-500 hover:bg-neutral-200/60"
                  onClick={addRow}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("row.new")}
                </button>
              </td>
              <td colSpan={Math.max(visibleFields.length - 1, 1)} />
            </tr>
          </tbody>
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
  const [draft, setDraft] = useState(false);
  const [name, setName] = useState("");
  const add = async (type: FieldType) => {
    await store.addField(type, name.trim() || undefined);
    setName("");
    setDraft(false);
  };
  if (draft) {
    return (
      <div className="flex flex-col gap-1 p-1">
        <input
          autoFocus
          className="h-7 w-36 rounded border border-brand-500 bg-white px-2 text-[12px] outline-none"
          placeholder={t("field.newName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add("text");
            if (e.key === "Escape") setDraft(false);
          }}
          onBlur={() => {
            if (name.trim()) void add("text");
            else setDraft(false);
          }}
        />
        <div className="flex gap-1">
          {(["text", "number", "date", "checkbox", "single_select", "multi_select"] as FieldType[]).map((tp) => (
            <button
              key={tp}
              className="flex-1 rounded border border-neutral-300 bg-white px-1 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void add(tp)}
            >
              {t(`field.type.${tp}` as never)}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <button
      data-testid="add-field"
      className="flex h-8 w-8 items-center justify-center text-neutral-500 hover:bg-neutral-300/50"
      title={t("field.new")}
      onClick={() => setDraft(true)}
    >
      <Plus className="h-4 w-4" />
    </button>
  );
}

/** 单元格显示（非编辑态） */
function CellDisplay({ field, value }: { field: DatabaseField; value: CellValue }) {
  const opts = parseFieldOptions(field.options);
  const text = formatCellValue(field.field_type, value, opts);
  if (field.field_type === "checkbox") {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-brand-600">
        {value === true ? "✓" : ""}
      </div>
    );
  }
  return (
    <div className={cn("h-full w-full truncate px-2 text-[13px] leading-8", isReadonlyType(field.field_type) && "text-neutral-400")}>
      {text}
    </div>
  );
}

/** 编辑态按类型分派编辑器 */
function CellEditorSlot(props: {
  field: DatabaseField;
  value: CellValue;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
}) {
  const { field, value, onCommit, onCancel } = props;
  switch (field.field_type) {
    case "number":
      return <NumberCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "date":
      return <DateCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "checkbox":
      return <CheckboxCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "single_select":
      return <SelectCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "multi_select":
      return <MultiSelectCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    default:
      return <TextCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
  }
}

