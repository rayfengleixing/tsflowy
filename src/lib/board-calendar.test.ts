import { describe, expect, it } from "vitest";
import {
  NO_GROUP,
  buildCalendarMonth,
  cellValueForDate,
  cellValueForGroup,
  defaultBoardField,
  defaultCalendarField,
  groupRowsForBoard,
  rowDateKey,
  toDateKey,
} from "./board-calendar";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";

function field(type: DatabaseField["field_type"], options?: string): DatabaseField {
  return {
    id: "f1",
    database_view_id: "v1",
    name: "F",
    field_type: type,
    options: options ?? "{}",
    width: 180,
    is_hidden: 0,
    position: 0,
  };
}

function row(id: string, position = 0): DatabaseRow {
  return { id, database_view_id: "v1", position, document_id: null, created_at: 0, updated_at: 0 };
}

const selectField = field(
  "single_select",
  JSON.stringify({
    kind: "select",
    options: [
      { id: "o1", name: "待办", color: "blue" },
      { id: "o2", name: "进行中", color: "green" },
    ],
  }),
);

describe("groupRowsForBoard", () => {
  const rows = [row("r1"), row("r2"), row("r3"), row("r4")];
  const cells: Record<string, Record<string, CellValue>> = {
    r1: { f1: "o1" },
    r2: { f1: "o2" },
    r3: { f1: "o1" },
    r4: { f1: null },
  };

  it("按选项分组且组顺序跟随选项定义顺序", () => {
    const groups = groupRowsForBoard(rows, cells, selectField);
    expect(groups.map((g) => g.key)).toEqual(["o1", "o2", NO_GROUP]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["r2"]);
  });

  it("没有未分组行时不产生未分组桶", () => {
    const cells2 = { r1: { f1: "o1" } };
    const groups = groupRowsForBoard([rows[0]], cells2, selectField);
    expect(groups.map((g) => g.key)).toEqual(["o1", "o2"]);
  });

  it("值指向已删除选项时落入未分组", () => {
    const groups = groupRowsForBoard([row("r9")], { r9: { f1: "ghost" } }, selectField);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(NO_GROUP);
    expect(groups[0].option).toBeNull();
  });

  it("cellValueForGroup：未分组桶清空选择", () => {
    expect(cellValueForGroup("o1")).toBe("o1");
    expect(cellValueForGroup(NO_GROUP)).toBeNull();
  });

  it("defaultBoardField 取第一个单选字段", () => {
    const fields = [field("text"), selectField, field("single_select")];
    expect(defaultBoardField(fields)?.id).toBe("f1");
    expect(defaultBoardField([field("text")])).toBeNull();
  });
});

describe("calendar helpers", () => {
  it("toDateKey 兼容纯日期与 ISO 时间串", () => {
    expect(toDateKey("2026-09-01")).toBe("2026-09-01");
    expect(toDateKey("2026-09-01T08:30:00.000Z")).toBe("2026-09-01");
    expect(toDateKey("not a date")).toBeNull();
  });

  it("rowDateKey 空值/非串返回 null", () => {
    expect(rowDateKey(row("r1"), { r1: { f1: "" } }, "f1")).toBeNull();
    expect(rowDateKey(row("r1"), { r1: { f1: 3 } }, "f1")).toBeNull();
    expect(rowDateKey(row("r1"), {}, "f1")).toBeNull();
    expect(rowDateKey(row("r1"), { r1: { f1: "2026-09-01" } }, "f1")).toBe("2026-09-01");
  });

  it("buildCalendarMonth：周一起、前置补位、行归格", () => {
    // 2026-09-01 是周二 → 前置 1 格补位
    const rows = [row("r1"), row("r2")];
    const cells: Record<string, Record<string, CellValue>> = {
      r1: { f1: "2026-09-01" },
      r2: { f1: "2026-08-31" }, // 跨月，不入格
    };
    const m = buildCalendarMonth(2026, 9, rows, cells, "f1");
    expect(m.days).toHaveLength(42);
    expect(m.days[0]).toMatchObject({ day: null, date: null });
    expect(m.days[1]).toMatchObject({ day: 1, date: "2026-09-01" });
    expect(m.days[1].rows.map((r) => r.id)).toEqual(["r1"]);
    expect(m.days.flat().reduce((n, d) => n + d.rows.length, 0)).toBe(1);
  });

  it("buildCalendarMonth：跨年月份正确（2026-02 共 28 天）", () => {
    const m = buildCalendarMonth(2026, 2, [], {}, "f1");
    expect(m.days.filter((d) => d.day).length).toBe(28);
    expect(m.days.find((d) => d.date === "2026-02-28")).toBeTruthy();
  });

  it("cellValueForDate 直接返回日期串", () => {
    expect(cellValueForDate("2026-09-01")).toBe("2026-09-01");
  });

  it("defaultCalendarField 取第一个日期类字段", () => {
    expect(defaultCalendarField([field("text"), field("date")])?.field_type).toBe("date");
    expect(defaultCalendarField([field("created_at")])?.field_type).toBe("created_at");
    expect(defaultCalendarField([field("text")])).toBeNull();
  });
});
