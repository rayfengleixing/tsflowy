import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, ExternalLink, LayoutList } from "lucide-react";
import { toast } from "sonner";
import { useDatabaseStore } from "@/stores/database";
import { applyFilters, isCellEmpty, sortRows } from "@/lib/database-query";
import { NO_GROUP, cellValueForGroup, defaultBoardField, groupRowsForBoard } from "@/lib/board-calendar";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SelectChips } from "./editors";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import type { CellValue, DatabaseField } from "@/types/database";
import type { View } from "@/types/models";

/** Board 看板视图（说明书 11 节 M5）：按单选字段分组 + 卡片拖拽改值 */
export function BoardView({
  view,
  source,
  tabs,
  onGoGrid,
}: {
  /** 当前视图：分组字段等显示配置的归属 */
  view: View;
  /** 宿主页面：标题、重命名与行详情的父子归属 */
  source: View;
  /** 顶栏左侧的视图标签栏（页内切换 grid/board/calendar） */
  tabs?: React.ReactNode;
  /** 无单选字段时引导回到表格视图 */
  onGoGrid?: () => void;
}) {
  const store = useDatabaseStore();
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [groupFieldId, setGroupFieldId] = useState<string | null>(() => readViewConfig(view).boardFieldId ?? null);
  // null = 未配置（沿用"主字段之后前 3 个可见字段"的默认启发式）；数组 = 用户显式勾选的字段
  const [cardFieldIds, setCardFieldIds] = useState<string[] | null>(() => readViewConfig(view).cardFieldIds ?? null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  useEffect(() => {
    store.load(view).catch((e) => logger.error("board.load", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  const changeGroupField = (id: string | null) => {
    setGroupFieldId(id);
    patchViewConfig(view, { boardFieldId: id ?? "" });
  };

  // 初始化默认分组字段
  useEffect(() => {
    if (fields.length === 0) return;
    const def = defaultBoardField(fields);
    if (groupFieldId && fields.some((f) => f.id === groupFieldId && f.field_type === "single_select")) {
      return;
    }
    setGroupFieldId(def?.id ?? null);
  }, [fields, groupFieldId]);

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  const primaryField = visibleFields[0] ?? null;
  const groupField = fields.find((f) => f.id === groupFieldId) ?? null;
  const selectFields = useMemo(() => fields.filter((f) => f.field_type === "single_select"), [fields]);

  const cardCandidates = useMemo(() => visibleFields.slice(1), [visibleFields]);
  const defaultCardFieldIds = useMemo(() => cardCandidates.slice(0, 3).map((f) => f.id), [cardCandidates]);
  const cardSubFields = useMemo(() => {
    const ids = cardFieldIds ?? defaultCardFieldIds;
    return ids.map((id) => cardCandidates.find((f) => f.id === id)).filter((f): f is DatabaseField => !!f);
  }, [cardCandidates, cardFieldIds, defaultCardFieldIds]);

  const toggleCardField = (id: string) => {
    const current = cardFieldIds ?? defaultCardFieldIds;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setCardFieldIds(next);
    patchViewConfig(view, { cardFieldIds: next });
  };

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, cells, filters, fields, filterMode);
    return sortRows(filtered, cells, sorts);
  }, [rows, cells, filters, fields, filterMode, sorts]);

  const groups = useMemo(() => {
    if (!groupField) return [];
    return groupRowsForBoard(displayRows, cells, groupField);
  }, [groupField, displayRows, cells]);

  // 搜索命中定位：折叠键作 revision，命中卡片所在列一展开就能重新定位
  const collapsedKey = [...collapsedGroups].join("|");
  const { scrollerRef, focusRowId } = useRowFocus(collapsedKey);
  useEffect(() => {
    if (!focusRowId) return;
    const hit = groups.find((g) => g.rows.some((r) => r.id === focusRowId));
    if (!hit || !collapsedGroups.has(hit.key)) return;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.delete(hit.key);
      return next;
    });
  }, [focusRowId, groups, collapsedGroups]);

  const commitCell = useCallback(
    async (rowId: string, fieldId: string, value: CellValue) => {
      try {
        await store.setCell(rowId, fieldId, value);
      } catch (e) {
        toast.error(t("error.db", { message: String(e) }));
      }
    },
    [store],
  );

  const addCardInGroup = async (groupKey: string) => {
    if (!groupField) return;
    try {
      const row = await store.addRow();
      if (row && groupKey !== NO_GROUP) {
        await store.setCell(row.id, groupField.id, cellValueForGroup(groupKey));
      }
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const addGroup = async () => {
    const name = newGroupName.trim();
    if (!name || !groupField) return;
    try {
      await store.addSelectOption(groupField.id, name);
      setNewGroupName("");
      setNewGroupOpen(false);
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const toggleAllCollapsed = (collapse: boolean) => {
    if (collapse) setCollapsedGroups(new Set(groups.map((g) => g.key)));
    else setCollapsedGroups(new Set());
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏（44px，和 GridView 一致）：左侧为页内视图切换 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <div className="flex min-w-0 flex-1 items-center">{tabs}</div>

        <div className="flex shrink-0 items-center gap-1">
          {/* 分组字段切换 */}
          <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700">
            <span className="text-neutral-500">{t("board.groupBy")}:</span>
            <select
              className="bg-transparent text-xs outline-none"
              value={groupFieldId ?? ""}
              onChange={(e) => changeGroupField(e.target.value || null)}
            >
              {selectFields.length === 0 && <option value="">{t("board.noField")}</option>}
              {selectFields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          {/* 卡片字段配置 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <LayoutList className="h-3.5 w-3.5" />
                {t("board.cardFields")}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>{t("board.cardFieldsHint")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {cardCandidates.map((f) => (
                <DropdownMenuCheckboxItem
                  key={f.id}
                  checked={(cardFieldIds ?? defaultCardFieldIds).includes(f.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => toggleCardField(f.id)}
                >
                  {f.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="ghost" size="sm" onClick={() => toggleAllCollapsed(true)}>
            {t("board.collapseAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggleAllCollapsed(false)}>
            {t("board.expandAll")}
          </Button>
        </div>
      </div>

      {/* 空态：没有单选字段 */}
      {!groupField ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-4xl">🗂️</div>
          <h2 className="text-base font-semibold text-neutral-800">{t("board.noField")}</h2>
          <p className="max-w-md text-sm text-neutral-500">{t("board.noFieldDesc")}</p>
          {onGoGrid && (
            <Button size="sm" onClick={onGoGrid}>
              {t("board.goGrid")}
            </Button>
          )}
        </div>
      ) : (
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-w-full gap-3 p-4">
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              const isUngrouped = group.key === NO_GROUP;
              const optionColor = group.option?.color ?? null;
              const accent = optionColor ? optionColorToClass(optionColor) : null;
              const overThis = dragOverGroup === group.key;
              return (
                <div
                  key={group.key}
                  className={cn(
                    "flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border bg-neutral-100/50",
                    overThis && draggingRow
                      ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
                      : "border-neutral-200",
                  )}
                  onDragOver={(e) => {
                    if (draggingRow) {
                      e.preventDefault();
                      if (dragOverGroup !== group.key) setDragOverGroup(group.key);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverGroup === group.key) setDragOverGroup(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggingRow) {
                      const rowId = draggingRow;
                      setDraggingRow(null);
                      setDragOverGroup(null);
                      void commitCell(rowId, groupField.id, cellValueForGroup(group.key));
                    }
                  }}
                >
                  {/* 列头：颜色点 + 名称 + count + 折叠 + 新增按钮 */}
                  <div className="flex items-center gap-2 border-b border-neutral-200 px-2 py-2">
                    <button
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200/60"
                      onClick={() => {
                        const next = new Set(collapsedGroups);
                        if (collapsed) next.delete(group.key);
                        else next.add(group.key);
                        setCollapsedGroups(next);
                      }}
                    >
                      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    {accent ? (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
                    ) : isUngrouped ? (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] text-neutral-400">
                        ⊘
                      </span>
                    ) : null}
                    <div className="min-w-0 flex-1 text-xs font-medium text-neutral-800">
                      {isUngrouped ? t("board.ungrouped") : (group.option?.name ?? group.key)}
                      <span className="ml-1.5 text-[10px] font-normal text-neutral-400">{group.rows.length}</span>
                    </div>
                    <button
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200/60"
                      onClick={() => addCardInGroup(group.key)}
                      title={t("board.addCard")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* 卡片列表（或折叠占位） */}
                  {collapsed ? (
                    <div className="px-2 py-2 text-[11px] text-neutral-400">
                      {t("board.collapseAll")}: {group.rows.length}
                    </div>
                  ) : (
                    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-2 py-2">
                      {group.rows.map((row) => (
                        <BoardCard
                          key={row.id}
                          row={row}
                          primaryField={primaryField}
                          subFields={cardSubFields}
                          subFieldsExplicit={cardFieldIds !== null}
                          cells={cells}
                          dragging={draggingRow === row.id}
                          focused={focusRowId === row.id}
                          onDragStart={() => setDraggingRow(row.id)}
                          onDragEnd={() => {
                            if (draggingRow === row.id) setDraggingRow(null);
                            if (dragOverGroup === group.key) setDragOverGroup(null);
                          }}
                          onOpenDetail={() => void openRowDetail(row, source)}
                        />
                      ))}
                      {/* 新建行按钮 */}
                      <button
                        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-left text-[12px] text-neutral-500 hover:bg-white hover:text-neutral-700"
                        onClick={() => addCardInGroup(group.key)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("board.addCard")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* 新建分组：放在最右侧，可输入 name 创建选项 */}
            <div className="flex w-72 shrink-0 flex-col rounded-lg border border-dashed border-neutral-300 bg-neutral-50/60 p-3">
              {newGroupOpen ? (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
                    placeholder={t("board.addGroupPlaceholder")}
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addGroup();
                      if (e.key === "Escape") {
                        setNewGroupOpen(false);
                        setNewGroupName("");
                      }
                    }}
                  />
                  <Button size="sm" onClick={() => void addGroup()}>
                    {t("common.add")}
                  </Button>
                </div>
              ) : (
                <button
                  className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700"
                  onClick={() => setNewGroupOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("board.addGroup")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}

function BoardCard(props: {
  row: { id: string; position: number };
  primaryField: DatabaseField | null;
  /** 卡片副信息字段：来自视图配置，未配置时由调用方给默认前三列 */
  subFields: DatabaseField[];
  /** subFields 是否为用户显式勾选：决定时间戳字段是否显示 */
  subFieldsExplicit: boolean;
  cells: Record<string, Record<string, CellValue>>;
  dragging: boolean;
  /** 搜索命中的卡片：滚动定位后短时高亮 */
  focused: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpenDetail: () => void;
}) {
  const { row, primaryField, subFields, subFieldsExplicit, cells, dragging, focused } = props;
  const value = primaryField ? (cells[row.id]?.[primaryField.id] ?? null) : null;
  const title = primaryField
    ? formatCellValue(primaryField.field_type, value, parseFieldOptions(primaryField.options))
    : `行 ${row.position + 1}`;

  // 副信息：单/多选 chips + 日期 + 复选框✓ + 文本/数字，空值不占位
  const subs: { field: DatabaseField; value: CellValue }[] = subFields
    .map((f) => ({ field: f, value: cells[row.id]?.[f.id] ?? null }))
    .filter((s) => cardSubShown(s.field, s.value, subFieldsExplicit));

  return (
    <div
      data-row-id={row.id}
      draggable
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      className={cn(
        "group/card cursor-grab rounded-md border bg-white p-2 shadow-sm transition active:cursor-grabbing dark:bg-neutral-800",
        dragging
          ? "opacity-40 ring-1 ring-brand-500"
          : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 hover:shadow",
        focused && ROW_FOCUS_CLASS,
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-h-[1.25rem] min-w-0 flex-1 break-words text-[13px] font-medium leading-snug text-neutral-800 dark:text-neutral-100">
          {title || <span className="text-neutral-300 dark:text-neutral-600">{t("board.cardNamePlaceholder")}</span>}
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition group-hover/card:opacity-100 hover:bg-neutral-200 hover:text-brand-600"
          title={t("row.openDetail")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenDetail();
          }}
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>
      {subs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {subs.map((s) => (
            <CardSub key={s.field.id} field={s.field} value={s.value} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单元格是否值得占用卡片副信息位：空值不显示，未勾选的复选框不显示 */
function cardSubShown(field: DatabaseField, value: CellValue, explicit: boolean): boolean {
  if (field.field_type === "checkbox") return value === true;
  if (!explicit && (field.field_type === "created_at" || field.field_type === "last_edited_at")) return false;
  return !isCellEmpty(value);
}

function CardSub({ field, value }: { field: DatabaseField; value: CellValue }) {
  if (field.field_type === "single_select" || field.field_type === "multi_select") {
    return (
      <div className="max-w-full min-h-[1rem]">
        <SelectChips field={field} value={value} compact />
      </div>
    );
  }
  if (field.field_type === "checkbox") {
    return <span className="text-[11px] font-medium text-brand-600">✓</span>;
  }
  if (field.field_type === "date") {
    const text = formatCellValue("date", value, parseFieldOptions(field.options));
    return text ? (
      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">{text}</span>
    ) : null;
  }
  const text = formatCellValue(field.field_type, value, parseFieldOptions(field.options));
  if (!text) return null;
  return (
    <span
      className="max-w-[120px] truncate rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600"
      title={text}
    >
      {text}
    </span>
  );
}

function optionColorToClass(color: string): string | null {
  // 9 种标准色（和 NewFieldDialog 一致），这里直接把 hex/命名色作为 inline style 背景
  if (/^[0-9a-fA-F]{6}$/.test(color)) return "#" + color;
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  switch (color) {
    case "blue":
      return "#3b82f6";
    case "green":
      return "#22c55e";
    case "orange":
      return "#f97316";
    case "red":
      return "#ef4444";
    case "purple":
      return "#a855f7";
    case "yellow":
      return "#eab308";
    case "pink":
      return "#ec4899";
    case "gray":
      return "#6b7280";
    case "cyan":
      return "#06b6d4";
  }
  return null;
}
