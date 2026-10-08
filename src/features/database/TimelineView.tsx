import { useEffect, useMemo, useState } from "react";
import { useDbStore } from "@/stores/database-context";
import { applyFilters, sortRows } from "@/lib/database-query";
import { defaultCalendarField, rowDateKey } from "@/lib/board-calendar";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import { DAY_MS, autoScale, buildAxis, parseDateKey, type Scale, type ScaleMode } from "@/lib/timeline";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import type { DatabaseRow } from "@/types/database";
import type { View } from "@/types/models";

// 时间线视图（只读 v1）：一条横向时间轴 + 每行按日期落位。
// 开始日期字段决定落点；再选一个结束日期字段则画成横跨的条，否则只画点。
// 「本视图用哪个日期字段」这类配置写在 views.extra（view-config 的 timelineStartFieldId /
// timelineEndFieldId），与日历的 calendarFieldId 同一套机制。
// 日期/刻度纯逻辑见 @/lib/timeline（可单测）。

/** Timeline 时间线视图：横向时间轴（只读，v1 不做拖拽改期） */
export function TimelineView({
  view,
  source,
  tabs,
  onGoGrid,
}: {
  /** 当前视图：日期字段等显示配置的归属 */
  view: View;
  /** 宿主页面：标题、重命名与行详情的父子归属 */
  source: View;
  /** 顶栏左侧的视图标签栏（页内切换 grid/board/calendar/timeline） */
  tabs?: React.ReactNode;
  /** 无日期字段时引导回到表格视图 */
  onGoGrid?: () => void;
}) {
  const store = useDbStore();
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [startFieldId, setStartFieldId] = useState<string | null>(
    () => readViewConfig(view).timelineStartFieldId ?? null,
  );
  const [endFieldId, setEndFieldId] = useState<string | null>(() => readViewConfig(view).timelineEndFieldId ?? null);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("auto");

  useEffect(() => {
    store.load(view).catch((e: unknown) => logger.error("timeline.load", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  const dateFields = useMemo(
    () => fields.filter((f) => ["date", "created_at", "last_edited_at"].includes(f.field_type)),
    [fields],
  );
  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  const primaryField = visibleFields.length > 0 ? visibleFields[0] : null;

  // 初始化开始日期字段：第一个 date/created_at/last_edited_at
  useEffect(() => {
    if (dateFields.length === 0) return;
    if (startFieldId && dateFields.some((f) => f.id === startFieldId)) return;
    setStartFieldId(defaultCalendarField(fields)?.id ?? null);
  }, [fields, dateFields, startFieldId]);

  // 结束日期字段失效（被删/改类型）时清空
  useEffect(() => {
    if (endFieldId && !dateFields.some((f) => f.id === endFieldId)) setEndFieldId(null);
  }, [dateFields, endFieldId]);

  const startField = fields.find((f) => f.id === startFieldId) ?? null;
  const endField = fields.find((f) => f.id === endFieldId) ?? null;

  const changeStartField = (id: string | null) => {
    setStartFieldId(id);
    patchViewConfig(view, { timelineStartFieldId: id ?? "" });
    // 结束字段与开始字段撞车时清掉，避免同一字段既当起又当止
    if (id && endFieldId === id) {
      setEndFieldId(null);
      patchViewConfig(view, { timelineEndFieldId: "" });
    }
  };
  const changeEndField = (id: string | null) => {
    setEndFieldId(id);
    patchViewConfig(view, { timelineEndFieldId: id ?? "" });
  };

  // 复用日历的取数方式：先筛后排序，再按日期落位
  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, cells, filters, fields, filterMode);
    return sortRows(filtered, cells, sorts);
  }, [rows, cells, filters, fields, filterMode, sorts]);

  const entries = useMemo(() => {
    if (!startField) return [];
    return displayRows.flatMap((row) => {
      const sk = rowDateKey(row, cells, startField.id);
      let s = sk ? parseDateKey(sk) : null;
      if (s === null) return [];
      const ek = endField ? rowDateKey(row, cells, endField.id) : null;
      let e = ek ? parseDateKey(ek) : s;
      e ??= s;
      if (e < s) [s, e] = [e, s];
      return [{ row, startMs: s, endMs: e }];
    });
  }, [displayRows, cells, startField, endField]);

  const range = useMemo(() => {
    if (entries.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const e of entries) {
      if (e.startMs < min) min = e.startMs;
      if (e.endMs > max) max = e.endMs;
    }
    return { min, max };
  }, [entries]);

  const scale: Scale = scaleMode === "auto" ? autoScale(range ? (range.max - range.min) / DAY_MS : 0) : scaleMode;

  const axis = useMemo(() => {
    if (!range) return null;
    return buildAxis(range, scale);
  }, [range, scale]);

  const { scrollerRef, focusRowId } = useRowFocus(axis ? `${scale}:${axis.domainStart}:${axis.span}` : "empty");

  const titleOf = (row: DatabaseRow): string => {
    if (!primaryField) return t("row.detailName", { n: row.position + 1 });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
    const value = cells[row.id]?.[primaryField.id] ?? null;
    return formatCellValue(primaryField.field_type, value, parseFieldOptions(primaryField.options));
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white dark:bg-neutral-900">
      {/* 顶栏（44px，和 GridView 一致）：左侧为页内视图切换 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6 dark:border-neutral-700">
        <div className="flex min-w-0 flex-1 items-center">{tabs}</div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
            <span className="text-neutral-500 dark:text-neutral-400">{t("timeline.startField")}:</span>
            <select
              className="bg-transparent text-xs outline-none"
              value={startFieldId ?? ""}
              onChange={(e) => changeStartField(e.target.value || null)}
            >
              {dateFields.length === 0 && <option value="">{t("calendar.noField")}</option>}
              {dateFields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          {/* 结束日期字段：本表还存在其它日期字段时才可选，不选则只画点 */}
          {dateFields.length > 1 && (
            <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
              <span className="text-neutral-500 dark:text-neutral-400">{t("timeline.endField")}:</span>
              <select
                className="bg-transparent text-xs outline-none"
                value={endFieldId ?? ""}
                onChange={(e) => changeEndField(e.target.value || null)}
              >
                <option value="">{t("timeline.noEnd")}</option>
                {dateFields
                  .filter((f) => f.id !== startFieldId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
            <span className="text-neutral-500 dark:text-neutral-400">{t("timeline.scale")}:</span>
            <select
              className="bg-transparent text-xs outline-none"
              value={scaleMode}
              onChange={(e) => setScaleMode(e.target.value as ScaleMode)}
            >
              <option value="auto">{t("timeline.scaleAuto")}</option>
              <option value="day">{t("timeline.scaleDay")}</option>
              <option value="week">{t("timeline.scaleWeek")}</option>
              <option value="month">{t("timeline.scaleMonth")}</option>
            </select>
          </div>
        </div>
      </div>

      {!startField ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-4xl">📆</div>
          <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">{t("timeline.noField")}</h2>
          <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">{t("timeline.noFieldDesc")}</p>
          {onGoGrid && (
            <Button size="sm" onClick={onGoGrid}>
              {t("board.goGrid")}
            </Button>
          )}
        </div>
      ) : !axis ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-4xl">📆</div>
          <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">{t("timeline.empty")}</h2>
          <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">{t("timeline.noFieldDesc")}</p>
        </div>
      ) : (
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="min-w-[720px]">
            {/* 轴标题行 */}
            <div className="flex border-b border-neutral-200 bg-neutral-100/60 text-[11px] text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/40 dark:text-neutral-400">
              <div className="w-44 shrink-0 border-r border-neutral-200 px-3 dark:border-neutral-700" />
              <div className="relative h-8 flex-1">
                {axis.ticks.map((tk, i) => (
                  <div key={i} className="absolute top-0 flex h-full items-center" style={{ left: `${tk.pct}%` }}>
                    <span className="-translate-x-1/2 whitespace-nowrap px-1">{tk.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 每行一条轨道：有结束日期画条，否则画点 */}
            {entries.map(({ row, startMs, endMs }) => {
              const left = ((startMs - axis.domainStart) / axis.span) * 100;
              const width = ((endMs - startMs) / axis.span) * 100;
              const isSpan = endMs > startMs;
              const title = titleOf(row);
              const focused = focusRowId === row.id;
              return (
                <div key={row.id} className="flex border-b border-neutral-100 dark:border-neutral-800">
                  <div
                    className="w-44 shrink-0 truncate border-r border-neutral-200 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-200"
                    title={title}
                  >
                    {title || (
                      <span className="text-neutral-300 dark:text-neutral-600">{t("board.cardNamePlaceholder")}</span>
                    )}
                  </div>
                  <div className="relative h-9 flex-1">
                    {/* 刻度线 */}
                    {axis.ticks.map((tk, i) => (
                      <div
                        key={i}
                        className="absolute inset-y-0 w-px bg-neutral-100 dark:bg-neutral-800"
                        style={{ left: `${tk.pct}%` }}
                      />
                    ))}
                    {isSpan ? (
                      <button
                        data-row-id={row.id}
                        className={cn(
                          "absolute top-1/2 h-5 -translate-y-1/2 overflow-hidden rounded bg-brand-500 px-2 text-left text-[11px] font-medium text-white shadow-sm transition hover:bg-brand-600",
                          focused && ROW_FOCUS_CLASS,
                        )}
                        style={{ left: `${left}%`, width: `${Math.max(width, 1)}%` }}
                        onClick={() => void openRowDetail(row, source)}
                        title={title}
                      >
                        <span className="block truncate leading-5">{title || t("board.cardNamePlaceholder")}</span>
                      </button>
                    ) : (
                      <button
                        data-row-id={row.id}
                        className={cn(
                          "absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800",
                          focused && ROW_FOCUS_CLASS,
                        )}
                        style={{ left: `${left}%` }}
                        onClick={() => void openRowDetail(row, source)}
                        title={title}
                      >
                        <span className="-ml-[5px] h-2.5 w-2.5 shrink-0 rounded-full bg-brand-500" />
                        <span className="truncate">{title || t("board.cardNamePlaceholder")}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}
