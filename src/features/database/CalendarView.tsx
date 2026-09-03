import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Table2 } from "lucide-react";
import { toast } from "sonner";
import { useDatabaseStore } from "@/stores/database";
import { useWorkspaceStore } from "@/stores/workspace";
import { applyFilters, sortRows } from "@/lib/database-query";
import {
  buildCalendarMonth,
  cellValueForDate,
  defaultCalendarField,
} from "@/lib/board-calendar";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { viewIcon } from "@/components/view-icon";
import { Button } from "@/components/ui/button";
import { SelectChips } from "./editors";
import { RowDetailPanel } from "./RowDetail";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { CellValue, DatabaseField } from "@/types/database";
import type { View } from "@/types/models";

/** Calendar 日历视图（说明书 11 节 M5）：月视图（周一起）+ 卡片拖拽改日期 */
export function CalendarView({ view }: { view: View }) {
  const store = useDatabaseStore();
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [dateFieldId, setDateFieldId] = useState<string | null>(null);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [month, setMonth] = useState<number>(new Date().getMonth() + 1);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(view.name);
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  useEffect(() => {
    store.load(view.id).catch((e) => console.error("calendar load failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  // 初始化日期字段：第一个 date/created_at/last_edited_at
  useEffect(() => {
    if (fields.length === 0) return;
    const def = defaultCalendarField(fields);
    if (dateFieldId && fields.some((f) => f.id === dateFieldId && ["date","created_at","last_edited_at"].includes(f.field_type))) {
      return;
    }
    setDateFieldId(def?.id ?? null);
  }, [fields, dateFieldId]);

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  const dateField = fields.find((f) => f.id === dateFieldId) ?? null;
  const dateFields = useMemo(
    () => fields.filter((f) => ["date", "created_at", "last_edited_at"].includes(f.field_type)),
    [fields],
  );

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, cells, filters, fields, filterMode);
    return sortRows(filtered, cells, sorts);
  }, [rows, cells, filters, fields, filterMode, sorts]);

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  const cal = useMemo(() => {
    if (!dateField) return null;
    return buildCalendarMonth(year, month, displayRows, cells, dateField.id);
  }, [dateField, year, month, displayRows, cells]);

  const addRowAtDate = async (dateKey: string) => {
    if (!dateField) return;
    if (dateField.field_type === "created_at" || dateField.field_type === "last_edited_at") {
      toast.error(t("error.db", { message: `Cannot set ${dateField.name}` }));
      return;
    }
    try {
      const row = await store.addRow();
      if (row) await store.setCell(row.id, dateField.id, cellValueForDate(dateKey));
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const setRowDate = async (rowId: string, dateKey: string) => {
    if (!dateField) return;
    if (dateField.field_type === "created_at" || dateField.field_type === "last_edited_at") return;
    try {
      await store.setCell(rowId, dateField.id, cellValueForDate(dateKey));
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const gotoPrevMonth = () => {
    setMonth((m) => {
      if (m === 1) {
        setYear((y) => y - 1);
        return 12;
      }
      return m - 1;
    });
  };
  const gotoNextMonth = () => {
    setMonth((m) => {
      if (m === 12) {
        setYear((y) => y + 1);
        return 1;
      }
      return m + 1;
    });
  };
  const gotoToday = () => {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };

  const openGrid = () => {
    const tree = useWorkspaceStore.getState().tree;
    const views: View[] = [];
    const walk = (nodes: View[]) => {
      for (const n of nodes) {
        views.push(n);
        // @ts-expect-error tree 带 children
        if (Array.isArray(n.children)) walk(n.children as View[]);
      }
    };
    walk(tree);
    const grid = views.find((v) => v.layout === "grid" && v.workspace_id === view.workspace_id);
    if (grid) useWorkspaceStore.getState().openView(grid.id);
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏 44px */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <span className="text-lg leading-none">{viewIcon(view)}</span>
        {editingTitle ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 text-[15px] font-medium text-neutral-800 outline-none focus:border-brand-500"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const name = titleDraft.trim();
              setEditingTitle(false);
              if (name && name !== view.name) void useWorkspaceStore.getState().renameView(view.id, name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <h1
            className="min-w-0 flex-1 truncate text-[15px] font-medium text-neutral-800"
            onDoubleClick={() => {
              setTitleDraft(view.name);
              setEditingTitle(true);
            }}
          >
            {view.name}
          </h1>
        )}

        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700">
            <span className="text-neutral-500">{t("calendar.dateBy")}:</span>
            <select
              className="bg-transparent text-xs outline-none"
              value={dateFieldId ?? ""}
              onChange={(e) => setDateFieldId(e.target.value || null)}
            >
              {dateFields.length === 0 && <option value="">{t("calendar.noField")}</option>}
              {dateFields.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-0.5 rounded-md border border-neutral-300 bg-white text-xs">
            <button
              className="rounded-l-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
              onClick={gotoPrevMonth}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-2 font-medium text-neutral-800">{year} / {String(month).padStart(2,"0")}</span>
            <button
              className="px-2 py-1 text-neutral-600 hover:bg-neutral-100"
              onClick={gotoNextMonth}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <Button variant="ghost" size="sm" onClick={gotoToday}>
            {t("calendar.today")}
          </Button>

          <Button variant="ghost" size="sm" onClick={openGrid} title={t("board.goGrid")}>
            <Table2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {!dateField ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-4xl">📅</div>
          <h2 className="text-base font-semibold text-neutral-800">{t("calendar.noField")}</h2>
          <p className="max-w-md text-sm text-neutral-500">{t("calendar.noFieldDesc")}</p>
          <Button size="sm" onClick={openGrid}>
            <Table2 className="mr-1 h-3.5 w-3.5" />
            {t("board.goGrid")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex h-full min-h-full flex-col">
            {/* 周标题行 */}
            <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-100/60 text-[11px] text-neutral-500">
              <div className="border-r border-neutral-200 px-2 py-1 text-right">{t("calendar.wMon")}</div>
              <div className="border-r border-neutral-200 px-2 py-1 text-right">{t("calendar.wTue")}</div>
              <div className="border-r border-neutral-200 px-2 py-1 text-right">{t("calendar.wWed")}</div>
              <div className="border-r border-neutral-200 px-2 py-1 text-right">{t("calendar.wThu")}</div>
              <div className="border-r border-neutral-200 px-2 py-1 text-right">{t("calendar.wFri")}</div>
              <div className="border-r border-neutral-200 px-2 py-1 text-right">{t("calendar.wSat")}</div>
              <div className="px-2 py-1 text-right">{t("calendar.wSun")}</div>
            </div>

            {/* 日期格：6 行 × 7 列 */}
            <div className="grid flex-1 grid-cols-7 grid-rows-6 auto-rows-fr">
              {cal?.days.map((d, i) => {
                const isWeekend = i % 7 >= 5;
                const isToday = d.date === today;
                const overThis = draggingRow && dragOverDate === d.date;
                return (
                  <div
                    key={i}
                    className={cn(
                      "relative flex min-h-[120px] flex-col border-b border-r border-neutral-200 bg-white transition",
                      isWeekend && "bg-neutral-50/60",
                      d.day === null && "bg-neutral-50/30",
                      overThis && "bg-brand-50 ring-1 ring-inset ring-brand-500",
                    )}
                    onDragOver={(e) => {
                      if (draggingRow && d.date) {
                        e.preventDefault();
                        if (dragOverDate !== d.date) setDragOverDate(d.date);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverDate === d.date) setDragOverDate(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggingRow && d.date) {
                        const rowId = draggingRow;
                        setDraggingRow(null);
                        setDragOverDate(null);
                        void setRowDate(rowId, d.date);
                      }
                    }}
                  >
                    <div className="flex items-center justify-between px-1.5 py-1">
                      {d.day !== null && (
                        <span
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                            isToday
                              ? "bg-brand-500 font-semibold text-white"
                              : isWeekend
                                ? "text-neutral-400"
                                : "text-neutral-700",
                          )}
                        >
                          {d.day}
                        </span>
                      )}
                      {d.date && (
                        <button
                          className="hidden rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 group-hover/row:inline-flex"
                          onClick={() => addRowAtDate(d.date!)}
                          title={t("calendar.addRow")}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col gap-1 px-1 pb-1">
                      {d.rows.map((row) => (
                        <CalCard
                          key={row.id}
                          row={row}
                          primaryField={visibleFields[0] ?? null}
                          visibleFields={visibleFields}
                          cells={cells}
                          dragging={draggingRow === row.id}
                          onDragStart={() => setDraggingRow(row.id)}
                          onDragEnd={() => {
                            if (draggingRow === row.id) setDraggingRow(null);
                            if (dragOverDate === d.date) setDragOverDate(null);
                          }}
                          onDoubleClick={() => void openRowDetail(row, view)}
                        />
                      ))}
                    </div>

                    {d.date && d.rows.length < 3 && (
                      <button
                        className="absolute inset-x-1 bottom-1 hidden rounded px-1 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 group-hover/row:block"
                        onClick={() => addRowAtDate(d.date!)}
                      >
                        + {t("calendar.addRow")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function CalCard(props: {
  row: { id: string; position: number };
  primaryField: DatabaseField | null;
  visibleFields: DatabaseField[];
  cells: Record<string, Record<string, CellValue>>;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDoubleClick: () => void;
}) {
  const { row, primaryField, visibleFields, cells, dragging } = props;
  const value = primaryField ? cells[row.id]?.[primaryField.id] ?? null : null;
  const title = primaryField
    ? formatCellValue(primaryField.field_type, value, parseFieldOptions(primaryField.options))
    : `行 ${row.position + 1}`;

  // 副信息：只取前 1 个可见单/多选/数字（紧凑）
  const subField = visibleFields.slice(1, 3).find((f) =>
    f.field_type === "single_select"
    || f.field_type === "multi_select"
    || (f.field_type === "checkbox" && cells[row.id]?.[f.id] === true)
    || (f.field_type === "number" && cells[row.id]?.[f.id] != null),
  );
  const sub = subField ? { field: subField, value: cells[row.id]?.[subField.id] ?? null } : null;

  return (
    <div
      draggable
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDoubleClick={props.onDoubleClick}
      className={cn(
        "group/card cursor-grab overflow-hidden rounded border bg-white text-[11px] leading-tight shadow-sm transition active:cursor-grabbing",
        dragging ? "opacity-40 ring-1 ring-brand-500" : "border-neutral-200 hover:border-neutral-300 hover:shadow-sm",
      )}
    >
      <div className="truncate px-1.5 py-1 font-medium text-neutral-800">
        {title || <span className="text-neutral-300">{t("board.cardNamePlaceholder")}</span>}
      </div>
      {sub && (
        <div className="border-t border-neutral-100 px-1.5 py-0.5">
          <CalSub field={sub.field} value={sub.value} />
        </div>
      )}
    </div>
  );
}

function CalSub({ field, value }: { field: DatabaseField; value: CellValue }) {
  if (field.field_type === "single_select" || field.field_type === "multi_select") {
    return <SelectChips field={field} value={value} compact />;
  }
  if (field.field_type === "checkbox") {
    return <span className="font-medium text-brand-600">✓</span>;
  }
  if (field.field_type === "number") {
    const txt = formatCellValue("number", value, parseFieldOptions(field.options));
    return txt ? <span className="text-neutral-500">{txt}</span> : null;
  }
  return null;
}
