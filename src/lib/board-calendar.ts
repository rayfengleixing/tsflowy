import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { parseFieldOptions } from "./database-values";
import type { SelectOptionLike } from "./database-values";

// 看板/日历视图纯逻辑（项目说明书 11 节：分组求值需单测）
// Board：按单选字段分组、未分组桶、卡片排序；
// Calendar：按日期字段归入月份格子、跨月丢弃。

/** 看板分组桶：option id 或 NO_GROUP（未分组） */
export const NO_GROUP = "__no_group__";

export interface BoardGroup {
  key: string; // 选项 id 或 NO_GROUP
  option: SelectOptionLike | null; // 未分组桶为 null
  rows: DatabaseRow[];
}

/** 按单选字段把行分组；组顺序 = 选项定义顺序，未分组恒最后 */
export function groupRowsForBoard(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  field: DatabaseField,
): BoardGroup[] {
  const opts = parseFieldOptions(field.options);
  const options = opts.kind === "select" ? opts.options : [];
  const groups: BoardGroup[] = options.map((o) => ({ key: o.id, option: o, rows: [] }));
  const noGroup: BoardGroup = { key: NO_GROUP, option: null, rows: [] };
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const row of rows) {
    const v = cells[row.id]?.[field.id];
    if (typeof v === "string" && byKey.has(v)) {
      byKey.get(v)!.rows.push(row);
    } else {
      noGroup.rows.push(row);
    }
  }
  const hasAnyMatched = groups.some((g) => g.rows.length > 0);
  // 若至少有一个行命中某个选项组，或没有任何行（保留空看板列结构），则保留全部选项组；
  // 否则（所有行都指向无效值/空值，没有任何行能落入选项组），丢弃空选项组，只返回未分组桶。
  if (hasAnyMatched || rows.length === 0) {
    return noGroup.rows.length > 0 ? [...groups, noGroup] : groups;
  }
  return noGroup.rows.length > 0 ? [noGroup] : [];
}

/** 卡片拖到某分组桶后应写入的单元格值（null=清空选择） */
export function cellValueForGroup(groupKey: string): CellValue {
  return groupKey === NO_GROUP ? null : groupKey;
}

/** 默认看板分组字段：第一个单选字段；没有则 null（UI 提示先建单选字段） */
export function defaultBoardField(fields: DatabaseField[]): DatabaseField | null {
  return fields.find((f) => f.field_type === "single_select") ?? null;
}

// ---------- 日历 ----------

export interface CalendarDay {
  /** 本月内日期（1..31）；前置/尾部补位为 null */
  day: number | null;
  date: string | null; // YYYY-MM-DD
  rows: DatabaseRow[];
}

export interface CalendarMonth {
  year: number;
  month: number; // 1-12
  /** 6 行 × 7 列（周一起），前置/尾部补 null */
  days: CalendarDay[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDateKey(iso: string): string | null {
  // 兼容 "YYYY-MM-DD" 与 "YYYY-MM-DDTHH:mm:ss.sssZ"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 行的日期字段值 → YYYY-MM-DD；无效/空 → null */
export function rowDateKey(
  row: DatabaseRow,
  cells: Record<string, Record<string, CellValue>>,
  fieldId: string,
): string | null {
  const v = cells[row.id]?.[fieldId];
  if (typeof v !== "string" || v === "") return null;
  return toDateKey(v);
}

/** 生成某年某月的月视图格子（周一起 42 格），行按日期归入 */
export function buildCalendarMonth(
  year: number,
  month: number,
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  fieldId: string,
): CalendarMonth {
  const first = new Date(year, month - 1, 1);
  // JS: getDay() 周日=0；周一起的偏移 = (day+6)%7
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const dayNum = i - lead + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      days.push({ day: null, date: null, rows: [] });
    } else {
      days.push({ day: dayNum, date: `${year}-${pad(month)}-${pad(dayNum)}`, rows: [] });
    }
  }
  const byDate = new Map(days.filter((d) => d.date).map((d) => [d.date!, d]));
  for (const row of rows) {
    const key = rowDateKey(row, cells, fieldId);
    if (key) byDate.get(key)?.rows.push(row);
  }
  return { year, month, days };
}

/** 拖拽/选择日期后写入的单元格值：沿用字段 include_time 约定（无时间） */
export function cellValueForDate(dateKey: string): string {
  return dateKey;
}

/** 默认日历日期字段：第一个日期类型字段（date/created_at/last_edited_at）；没有则 null */
export function defaultCalendarField(fields: DatabaseField[]): DatabaseField | null {
  return fields.find((f) => ["date", "created_at", "last_edited_at"].includes(f.field_type)) ?? null;
}

export { SelectOptionLike };
