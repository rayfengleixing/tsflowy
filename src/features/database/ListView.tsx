import { useEffect, useMemo } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";
import { useDbStore } from "@/stores/database-context";
import { QueryButtons, QueryPanels, useQueryBar } from "./query-bar";
import { CondFormatButton, CondFormatDialogHost, useCondFormat } from "./cond-format-bar";
import { COND_TONE_CELL, toneOfIndex, type CondTone } from "@/lib/database-cond-format";
import { applyFilters, isCellEmpty, sortRows } from "@/lib/database-query";
import { computeEvaluatedCells, rowCellsOf } from "@/lib/database-evaluated-cells";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { useRelationDbs } from "./use-database-data";
import { Button } from "@/components/ui/button";
import { CellReadValue } from "./cell-display";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import type { View } from "@/types/models";

/**
 * List 列表视图：一行一条紧凑记录，主字段当标题、其余可见字段横向排开。
 * 与表格视图的分工是「看内容」而不是「看结构」——列宽不再受限，长文本一行读完。
 * 数据管线（筛选/排序/计算列求值）与看板、日历完全同源，配置也读同一份 store。
 */
export function ListView({
  view,
  source,
  tabs,
}: {
  /** 当前视图：筛选/排序配置的归属 */
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

  useEffect(() => {
    load(view).catch((e: unknown) => logger.error("list.load", e));
  }, [load, view]);

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  const primaryField = visibleFields[0] ?? null;
  const propFields = useMemo(() => visibleFields.slice(1), [visibleFields]);

  const relationDbOf = useRelationDbs(fields);

  const sortableCells = useMemo(
    () => computeEvaluatedCells(rows, cells, fields, relationDbOf).sortable,
    [rows, cells, fields, relationDbOf],
  );

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, sortableCells, filters, fields, filterMode);
    return sortRows(filtered, sortableCells, sorts);
  }, [rows, sortableCells, filters, fields, filterMode, sorts]);

  // 公式/汇总/反向关系没有存储值：整屏一次求值，行渲染只读结果图
  const evaluated = useMemo(
    () => computeEvaluatedCells(displayRows, cells, fields, relationDbOf).display,
    [displayRows, cells, fields, relationDbOf],
  );

  // 条件格式（与表格视图同一份按视图持久化的规则）：按展示图判定，公式列也能当条件
  const condRowIds = useMemo(() => displayRows.map((r) => r.id), [displayRows]);
  const cond = useCondFormat(view, condRowIds, evaluated);

  const { scrollerRef, focusRowId } = useRowFocus(displayRows.length);

  const addRow = async () => {
    try {
      await store.addRow();
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏（44px，和其它视图一致）：左侧为页内视图切换 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <div className="flex min-w-0 flex-1 items-center">{tabs}</div>
        <div className="flex shrink-0 items-center gap-2">
          <QueryButtons bar={bar} />
          <CondFormatButton bar={cond} />
          <span className="text-xs text-neutral-400">{displayRows.length}</span>
          <Button variant="ghost" size="sm" onClick={() => void addRow()}>
            <Plus className="h-3.5 w-3.5" />
            {t("row.new")}
          </Button>
        </div>
      </div>

      <QueryPanels bar={bar} />

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        {displayRows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            {t("databaseView.noRows")}
          </div>
        ) : (
          <div className="divide-y divide-neutral-100">
            {displayRows.map((row) => (
              <ListRow
                key={row.id}
                row={row}
                primaryField={primaryField}
                propFields={propFields}
                rowCells={rowCellsOf(evaluated, cells, row.id)}
                condToneIndex={cond.index}
                focused={focusRowId === row.id}
                onOpenDetail={() => void openRowDetail(row, source)}
              />
            ))}
          </div>
        )}
      </div>

      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}

      <CondFormatDialogHost bar={cond} />
    </div>
  );
}

/** 单行：标题占固定宽度，属性横向排开；空属性不显示，避免一屏「字段: 空」 */
function ListRow({
  row,
  primaryField,
  propFields,
  rowCells,
  condToneIndex,
  focused,
  onOpenDetail,
}: {
  row: DatabaseRow;
  primaryField: DatabaseField | null;
  propFields: DatabaseField[];
  /** 该行已求值的单元格图（计算列在内）；按行稀疏存储，没有条目即空值 */
  rowCells: Record<string, CellValue | undefined>;
  /** 条件格式取色索引（行 × 列 → 颜色），由列表视图整屏算好传进来 */
  condToneIndex: Map<string, CondTone>;
  focused: boolean;
  onOpenDetail: () => void;
}) {
  const primaryValue = primaryField ? (rowCells[primaryField.id] ?? null) : null;
  const title = primaryField
    ? formatCellValue(primaryField.field_type, primaryValue, parseFieldOptions(primaryField.options))
    : "";
  const props = propFields
    .map((f) => ({ field: f, value: rowCells[f.id] ?? null }))
    .filter((p) => !isCellEmpty(p.value));

  // 取色口径与表格视图一致：整行档铺满这一行，单元格档只铺它对应那个属性
  const rowTone = toneOfIndex(condToneIndex, row.id, "");
  const titleTone = primaryField ? toneOfIndex(condToneIndex, row.id, primaryField.id) : null;

  return (
    <div
      data-row-id={row.id}
      className={cn(
        "group/row flex cursor-pointer items-start gap-3 px-6 py-2 transition hover:bg-neutral-50 dark:hover:bg-neutral-800/40",
        focused && ROW_FOCUS_CLASS,
        rowTone && COND_TONE_CELL[rowTone],
      )}
      onClick={onOpenDetail}
    >
      <span
        className={cn(
          "w-64 shrink-0 truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100",
          titleTone && COND_TONE_CELL[titleTone],
        )}
      >
        {title || <span className="font-normal text-neutral-400">{t("board.cardNamePlaceholder")}</span>}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {props.map((p) => {
          const tone = toneOfIndex(condToneIndex, row.id, p.field.id);
          return (
            <span key={p.field.id} className="inline-flex min-w-0 max-w-[280px] items-center gap-1">
              <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{p.field.name}</span>
              <span className={cn("min-w-0", tone && COND_TONE_CELL[tone])}>
                <CellReadValue field={p.field} value={p.value} />
              </span>
            </span>
          );
        })}
      </span>
      <button
        type="button"
        className="mt-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 group-hover/row:inline-flex hover:bg-neutral-200 hover:text-brand-600"
        title={t("row.openDetail")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onOpenDetail();
        }}
      >
        <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}
