import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";
import { useDbStore } from "@/stores/database-context";
import { QueryButtons, QueryPanels, useQueryBar } from "./query-bar";
import { CondFormatButton, CondFormatDialogHost, useCondFormat } from "./cond-format-bar";
import { COND_TONE_CELL, toneOfIndex, type CondTone } from "@/lib/database/database-cond-format";
import { applyFilters, sortRows } from "@/lib/database/database-query";
import { computeEvaluatedCells, rowCellsOf } from "@/lib/database/database-evaluated-cells";
import { isReadonlyType } from "@/types/database";
import { useRelationDbs } from "./use-database-data";
import { Button } from "@/components/ui/button";
import { CellEditorSlot } from "./editors";
import { CellReadValue } from "./cell-display";
import { fieldIcon } from "./field-icon";
import { RowDetailPanel } from "./RowDetail";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import type { View } from "@/types/models";

/**
 * Form 表单视图：一条记录占一屏，字段自上而下逐格录入。
 * 存在的理由是表格视图改不动长内容——多行文本、附件、关联这种要在窄列里挤着改的字段，
 * 在这里有整行宽度；配合「上一行 / 下一行」可以把一批记录按表单顺序过一遍。
 * 值仍然直接落库（和表格、行详情同一套 setCell），表单只是换一种录入顺序，不是草稿。
 */
export function FormView({
  view,
  source,
  tabs,
}: {
  /** 当前视图：筛选/排序配置决定了能在哪些行之间翻页 */
  view: View;
  /** 宿主页面：行详情的父子归属 */
  source: View;
  /** 顶栏左侧的视图标签栏 */
  tabs?: React.ReactNode;
}) {
  const store = useDbStore();
  // 筛选/排序条（与表格视图同一份按视图持久化的配置）
  const bar = useQueryBar();
  const load = useDbStore((s) => s.load);
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [currentRowId, setCurrentRowId] = useState<string | null>(null);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);

  useEffect(() => {
    load(view).catch((e: unknown) => logger.error("form.load", e));
  }, [load, view]);

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  const relationDbOf = useRelationDbs(fields);

  const sortableCells = useMemo(
    () => computeEvaluatedCells(rows, cells, fields, relationDbOf).sortable,
    [rows, cells, fields, relationDbOf],
  );

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, sortableCells, filters, fields, filterMode);
    return sortRows(filtered, sortableCells, sorts);
  }, [rows, sortableCells, filters, fields, filterMode, sorts]);

  // 停在某一行的话换筛选/排序后可能不再命中：回落第一条，别让表单停在空记录上
  const row: DatabaseRow | null =
    displayRows.find((r) => r.id === currentRowId) ?? (displayRows.length > 0 ? displayRows[0] : null);
  const rowIndex = row ? displayRows.findIndex((r) => r.id === row.id) : -1;

  // 计算列（公式/汇总/反向关系）没有存储值：本行现算一次，行渲染与条件格式都读这份图
  const rowEvaluated = useMemo<Record<string, Record<string, CellValue>>>(
    () => (row ? computeEvaluatedCells([row], cells, fields, relationDbOf).display : {}),
    [row, cells, fields, relationDbOf],
  );
  const rowCells: Record<string, CellValue> = useMemo(
    () => (row ? rowCellsOf(rowEvaluated, cells, row.id) : {}),
    [row, rowEvaluated, cells],
  );

  // 条件格式（与表格视图同一份按视图持久化的规则）：表单一次只看一行，索引也只算这一行
  const condRowIds = useMemo(() => (row ? [row.id] : []), [row]);
  const cond = useCondFormat(view, condRowIds, rowEvaluated);

  const commit = useCallback(
    async (fieldId: string, value: CellValue) => {
      if (!row) return;
      setEditingFieldId(null);
      try {
        await store.setCell(row.id, fieldId, value);
      } catch (e) {
        toast.error(t("error.db", { message: String(e) }));
      }
    },
    [row, store],
  );

  const addRow = async () => {
    try {
      const created = await store.addRow();
      if (created) setCurrentRowId(created.id);
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const step = (delta: number) => {
    const nextIndex = rowIndex + delta;
    if (nextIndex < 0 || nextIndex >= displayRows.length) return;
    setCurrentRowId(displayRows[nextIndex].id);
    setEditingFieldId(null);
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏（44px，和其它视图一致）：左侧为页内视图切换 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <div className="flex min-w-0 flex-1 items-center">{tabs}</div>

        <div className="flex shrink-0 items-center gap-1">
          <QueryButtons bar={bar} />
          <CondFormatButton bar={cond} />
          <div className="flex items-center rounded-md border border-neutral-300 bg-white text-xs">
            <button
              className="rounded-l-md px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:cursor-default disabled:text-neutral-300"
              disabled={rowIndex <= 0}
              onClick={() => step(-1)}
              title={t("form.prevRow")}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-2 tabular-nums text-neutral-700">
              {row ? `${rowIndex + 1} / ${displayRows.length}` : `0 / ${displayRows.length}`}
            </span>
            <button
              className="px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:cursor-default disabled:text-neutral-300"
              disabled={rowIndex < 0 || rowIndex >= displayRows.length - 1}
              onClick={() => step(1)}
              title={t("form.nextRow")}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void addRow()}>
            <Plus className="h-3.5 w-3.5" />
            {t("row.new")}
          </Button>
        </div>
      </div>

      <QueryPanels bar={bar} />

      {!row ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-4xl">📝</div>
          <h2 className="text-base font-semibold text-neutral-800">{t("databaseView.noRows")}</h2>
          <p className="max-w-md text-sm text-neutral-500">{t("form.emptyDesc")}</p>
          <Button size="sm" onClick={() => void addRow()}>
            {t("row.new")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-6 py-6">
            <div className="mb-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-neutral-800">{source.name}</span>
              <Button variant="ghost" size="sm" onClick={() => void openRowDetail(row, source)}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t("row.openDetail")}
              </Button>
            </div>
            {visibleFields.map((field, i) => (
              <FormRow
                key={field.id}
                field={field}
                value={rowCells[field.id] ?? null}
                primary={i === 0}
                tone={toneOfIndex(cond.index, row.id, field.id)}
                rowTone={toneOfIndex(cond.index, row.id, "")}
                editing={editingFieldId === field.id}
                onStartEdit={() => setEditingFieldId(field.id)}
                onCancel={() => setEditingFieldId(null)}
                onCommit={(v) => void commit(field.id, v)}
              />
            ))}
          </div>
        </div>
      )}

      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}

      <CondFormatDialogHost bar={cond} />
    </div>
  );
}

/** 一行一个字段：左标签右录入框，只读类型（公式/汇总/反向关系/最后编辑时间）不给编辑入口 */
function FormRow({
  field,
  value,
  primary,
  tone,
  rowTone,
  editing,
  onStartEdit,
  onCancel,
  onCommit,
}: {
  field: DatabaseField;
  value: CellValue;
  primary: boolean;
  /** 该字段的条件格式取色（含整行档的回落） */
  tone: CondTone | null;
  /** 整行那一档的取色，铺满这一字段行 */
  rowTone: CondTone | null;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onCommit: (value: CellValue) => void;
}) {
  const store = useDbStore();
  const readonly = isReadonlyType(field.field_type);

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-neutral-100 py-1.5 last:border-b-0 dark:border-neutral-800",
        rowTone && COND_TONE_CELL[rowTone],
      )}
    >
      <span className="flex w-40 shrink-0 items-center gap-1.5 pt-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400">
          {fieldIcon(field.field_type)}
        </span>
        <span className="min-w-0 truncate" title={field.name}>
          {field.name}
        </span>
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 rounded px-1.5 py-1 text-[13px]",
          readonly ? "opacity-70" : "cursor-text hover:bg-neutral-100 dark:hover:bg-neutral-800",
          tone && COND_TONE_CELL[tone],
        )}
        onClick={() => !readonly && !editing && onStartEdit()}
      >
        {editing && !readonly ? (
          <CellEditorSlot
            field={field}
            value={value}
            onCommit={onCommit}
            onCancel={onCancel}
            onAddOption={(name) => store.addSelectOption(field.id, name)}
            onDeleteOption={(optionId) => void store.removeSelectOption(field.id, optionId)}
          />
        ) : (
          <span className={cn("block min-h-[22px]", primary && "font-medium")}>
            <CellReadValue field={field} value={value} />
          </span>
        )}
      </div>
    </div>
  );
}
