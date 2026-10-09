import { useEffect, useMemo, useRef, useState } from "react";
import { useDbStore } from "@/stores/database-context";
import { applyFilters, sortRows } from "@/lib/database-query";
import { defaultCalendarField, rowDateKey } from "@/lib/board-calendar";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import {
  DAY_MS,
  autoScale,
  buildAxis,
  floorToScale,
  msToDateKey,
  parseDateKey,
  pointerToDayMs,
  type Scale,
  type ScaleMode,
} from "@/lib/timeline";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import type { DatabaseRow } from "@/types/database";
import type { View } from "@/types/models";

// 时间线视图：一条横向时间轴 + 每行按日期落位。
// 开始日期字段决定落点；再选一个结束日期字段则画成横跨的条，否则只画点。
// 「本视图用哪个日期字段」这类配置写在 views.extra（view-config 的 timelineStartFieldId /
// timelineEndFieldId），与日历的 calendarFieldId 同一套机制。
// 日期/刻度纯逻辑见 @/lib/timeline（可单测）。
// v2 交互：拖动点/条改开始日期（条整体拖动保持时长不变），拖条右缘改结束日期；
// 仅当字段类型为 date 时可写（created_at/last_edited_at 只读，拖了不生效）。

/** Timeline 时间线视图：横向时间轴，支持拖拽改期（条可拖整体或拖右缘） */
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
  const load = useDbStore((s) => s.load);
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [startFieldId, setStartFieldId] = useState<string | null>(
    () => readViewConfig(view).timelineStartFieldId ?? null,
  );
  const [endFieldId, setEndFieldId] = useState<string | null>(() => readViewConfig(view).timelineEndFieldId ?? null);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("auto");

  useEffect(() => {
    load(view).catch((e: unknown) => logger.error("timeline.load", e));
  }, [load, view]);

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

  // ---- 拖拽改期（v2）----
  // 仅 date 类型字段可写：created_at 手动可改但语义上是历史值、last_edited_at 由触发器强制刷新，
  // 都不可拖。拖拽期间用 dragPreview 覆盖该行的起止做即时渲染，pointerup 时一次写入。
  const [dragPreview, setDragPreview] = useState<{ rowId: string; startMs: number; endMs: number } | null>(null);
  const suppressClickRef = useRef(false);
  const startWritable = startField?.field_type === "date";
  const endWritable = endField?.field_type === "date";
  // 整体拖动要同时写起止两列：选了结束字段但它不可写时，只挪开始日会改变时长，故禁用整体拖动
  const moveDraggable = startWritable && (!endField || endWritable);

  const beginDrag = (
    e: React.PointerEvent<HTMLElement>,
    entry: { row: DatabaseRow; startMs: number; endMs: number },
    mode: "move" | "resize",
  ) => {
    if (!axis || !startField) return;
    if (mode === "move" ? !moveDraggable : !(startWritable && endWritable)) return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget.closest("[data-track]")?.getBoundingClientRect();
    if (!track) return;
    const origin = { startMs: entry.startMs, endMs: entry.endMs };
    const startX = e.clientX;
    const axisRef = axis;
    let moved = false;
    let latest = { ...origin };
    const onMove = (ev: PointerEvent) => {
      // 4px 死区：轻微抖动仍按点击处理（打开行详情）
      if (!moved && Math.abs(ev.clientX - startX) < 4) return;
      moved = true;
      const dayMs = pointerToDayMs(ev.clientX, track, axisRef.domainStart, axisRef.span);
      if (mode === "move") {
        const delta = dayMs - origin.startMs;
        latest = { startMs: origin.startMs + delta, endMs: origin.endMs + delta };
      } else {
        latest = { startMs: origin.startMs, endMs: Math.max(dayMs, origin.startMs) };
      }
      setDragPreview({ rowId: entry.row.id, ...latest });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) return;
      // 拖完紧跟的 click 要吞掉；若指针在元素外释放（click 不触发），下一拍自动过期
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      setDragPreview(null);
      void (async () => {
        try {
          const updates: { rowId: string; fieldId: string; value: string }[] = [
            { rowId: entry.row.id, fieldId: startField.id, value: msToDateKey(latest.startMs) },
          ];
          if (endField && endWritable && latest.endMs !== origin.endMs) {
            updates.push({ rowId: entry.row.id, fieldId: endField.id, value: msToDateKey(latest.endMs) });
          }
          await store.setCellsMany(updates);
        } catch (err) {
          logger.error("timeline.drag", err);
        }
      })();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const openFromClick = (row: DatabaseRow) => {
    // 拖拽结束会触发一次 click，吞掉它，避免拖完误开详情面板
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    void openRowDetail(row, source);
  };

  // 「今天」参考线：今天在轴域内才画
  const todayPct = useMemo(() => {
    if (!axis) return null;
    const t0 = floorToScale(Date.now(), "day");
    if (t0 < axis.domainStart || t0 >= axis.domainStart + axis.span) return null;
    return ((t0 - axis.domainStart) / axis.span) * 100;
  }, [axis]);

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

            {/* 每行一条轨道：有结束日期画条，否则画点；可拖拽改期 */}
            {entries.map((entry) => {
              const { row } = entry;
              const preview = dragPreview?.rowId === row.id ? dragPreview : null;
              const startMs = preview ? preview.startMs : entry.startMs;
              const endMs = preview ? preview.endMs : entry.endMs;
              const left = ((startMs - axis.domainStart) / axis.span) * 100;
              const width = ((endMs - startMs) / axis.span) * 100;
              const isSpan = endMs > startMs;
              const title = titleOf(row);
              const focused = focusRowId === row.id;
              const draggable = moveDraggable;
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
                  <div data-track className="relative h-9 flex-1">
                    {/* 刻度线 */}
                    {axis.ticks.map((tk, i) => (
                      <div
                        key={i}
                        className="absolute inset-y-0 w-px bg-neutral-100 dark:bg-neutral-800"
                        style={{ left: `${tk.pct}%` }}
                      />
                    ))}
                    {/* 「今天」参考线 */}
                    {todayPct !== null && (
                      <div className="absolute inset-y-0 w-px bg-red-400/70" style={{ left: `${todayPct}%` }} />
                    )}
                    {isSpan ? (
                      <div
                        data-row-id={row.id}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "absolute top-1/2 h-5 -translate-y-1/2 overflow-visible rounded bg-brand-500 text-left text-[11px] font-medium text-white shadow-sm transition",
                          draggable ? "cursor-grab active:cursor-grabbing hover:bg-brand-600" : "hover:bg-brand-600",
                          focused && ROW_FOCUS_CLASS,
                          dragPreview?.rowId === row.id && "opacity-80",
                        )}
                        style={{ left: `${left}%`, width: `${Math.max(width, 1)}%` }}
                        onClick={() => openFromClick(row)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openFromClick(row);
                          }
                        }}
                        onPointerDown={(e) => beginDrag(e, entry, "move")}
                        title={
                          draggable ? `${title || t("board.cardNamePlaceholder")}（${t("timeline.dragHint")}）` : title
                        }
                      >
                        <span className="block truncate rounded bg-brand-500 leading-5 px-2">
                          {title || t("board.cardNamePlaceholder")}
                        </span>
                        {startWritable && endWritable && (
                          <span
                            className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize rounded-r bg-brand-700/60 hover:bg-brand-700"
                            onPointerDown={(e) => beginDrag(e, entry, "resize")}
                          />
                        )}
                      </div>
                    ) : (
                      <div
                        data-row-id={row.id}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800",
                          draggable && "cursor-grab active:cursor-grabbing",
                          focused && ROW_FOCUS_CLASS,
                          dragPreview?.rowId === row.id && "opacity-80",
                        )}
                        style={{ left: `${left}%` }}
                        onClick={() => openFromClick(row)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openFromClick(row);
                          }
                        }}
                        onPointerDown={(e) => beginDrag(e, entry, "move")}
                        title={
                          draggable ? `${title || t("board.cardNamePlaceholder")}（${t("timeline.dragHint")}）` : title
                        }
                      >
                        <span className="-ml-[5px] h-2.5 w-2.5 shrink-0 rounded-full bg-brand-500" />
                        <span className="truncate">{title || t("board.cardNamePlaceholder")}</span>
                      </div>
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
