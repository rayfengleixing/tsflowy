import { describe, expect, it } from "vitest";
import {
  UNGROUPED,
  applyFilters,
  canGroupBy,
  defaultOperand,
  evaluateFilter,
  groupRowsForGrid,
  isCellEmpty,
  makeRelativeOperand,
  opsForType,
  relativeDayRange,
  sortRows,
  type FilterSpec,
  type GridGroup,
} from "./database-query";
import type { DatabaseField, DatabaseRow } from "@/types/database";

const field = (id: string, type: DatabaseField["field_type"], options = "{}"): DatabaseField => ({
  id,
  database_view_id: "v1",
  name: id,
  field_type: type,
  options,
  width: 180,
  is_hidden: 0,
  position: 0,
});

const row = (id: string): DatabaseRow => ({
  id,
  database_view_id: "v1",
  position: 0,
  document_id: null,
  created_at: 0,
  updated_at: 0,
});

const cellsOf = (m: Record<string, Record<string, unknown>>): Record<string, Record<string, never>> => m as never;

describe("isCellEmpty", () => {
  it("treats null/empty string/empty array as empty", () => {
    expect(isCellEmpty(null)).toBe(true);
    expect(isCellEmpty("")).toBe(true);
    expect(isCellEmpty([])).toBe(true);
    expect(isCellEmpty(0)).toBe(false);
    expect(isCellEmpty(false)).toBe(false);
    expect(isCellEmpty("x")).toBe(false);
  });
});

describe("sortRows", () => {
  const rows = [row("a"), row("b"), row("c")];
  const cells = cellsOf({
    a: { n: 10, t: "banana" },
    b: { n: 2, t: "apple" },
    c: { n: null, t: null },
  });

  it("sorts numbers ascending with empty last", () => {
    const out = sortRows(rows, cells, [{ field_id: "n", dir: "asc" }]);
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts numbers descending with empty still last", () => {
    const out = sortRows(rows, cells, [{ field_id: "n", dir: "desc" }]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts text with locale compare", () => {
    const out = sortRows(rows, cells, [{ field_id: "t", dir: "asc" }]);
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("multi-key sort follows spec order", () => {
    const out = sortRows(rows, cells, [
      { field_id: "n", dir: "asc" },
      { field_id: "t", dir: "desc" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("returns original order when no sorts", () => {
    expect(sortRows(rows, cells, [])).toEqual(rows);
  });
});

describe("evaluateFilter", () => {
  it("evaluates emptiness ops", () => {
    expect(evaluateFilter("text", "", "is_empty", null)).toBe(true);
    expect(evaluateFilter("text", "x", "is_empty", null)).toBe(false);
    expect(evaluateFilter("text", "x", "is_not_empty", null)).toBe(true);
  });

  it("evaluates text contains / equals", () => {
    expect(evaluateFilter("text", "Hello World", "contains", "hello")).toBe(true);
    expect(evaluateFilter("text", "Hello World", "not_contains", "xyz")).toBe(true);
    expect(evaluateFilter("text", "Hello", "equals", "Hello")).toBe(true);
    expect(evaluateFilter("text", "Hello", "equals", "hello")).toBe(false);
  });

  it("evaluates number comparisons", () => {
    expect(evaluateFilter("number", 10, "gt", 5)).toBe(true);
    expect(evaluateFilter("number", 10, "gte", 10)).toBe(true);
    expect(evaluateFilter("number", 10, "lt", 5)).toBe(false);
    expect(evaluateFilter("number", 10, "lte", 10)).toBe(true);
    expect(evaluateFilter("number", null, "gt", 5)).toBe(false); // 空值不命中
  });

  it("evaluates date string comparisons", () => {
    expect(evaluateFilter("date", "2026-08-31", "gt", "2026-01-01")).toBe(true);
    expect(evaluateFilter("date", "2026-08-31", "lt", "2027-01-01")).toBe(true);
  });

  it("compares date fields by calendar day, including time-bearing cells", () => {
    // 本地正午 → ISO：dayMs 折回本地日，任何时区下都落在同一天，测试不依赖运行机器时区
    const noonIso = (day: string) => new Date(`${day}T12:00:00`).toISOString();
    const cell = noonIso("2026-10-13");
    expect(evaluateFilter("date", cell, "equals", "2026-10-13")).toBe(true);
    expect(evaluateFilter("date", cell, "not_equals", "2026-10-12")).toBe(true);
    expect(evaluateFilter("date", cell, "gt", "2026-10-13")).toBe(false); // 旧字符串比较：带时间恒大于纯日期
    expect(evaluateFilter("date", cell, "gte", "2026-10-13")).toBe(true);
    expect(evaluateFilter("date", cell, "lt", "2026-10-14")).toBe(true);
    expect(evaluateFilter("created_at", cell, "lte", "2026-10-13")).toBe(true);
    // 操作数未填保持旧行为：equals 不命中、not_equals 全命中
    expect(evaluateFilter("date", "2026-10-13", "equals", null)).toBe(false);
    expect(evaluateFilter("date", "2026-10-13", "not_equals", null)).toBe(true);
  });

  it("evaluates checkbox ops", () => {
    expect(evaluateFilter("checkbox", true, "checked", null)).toBe(true);
    expect(evaluateFilter("checkbox", false, "unchecked", null)).toBe(true);
    expect(evaluateFilter("checkbox", true, "unchecked", null)).toBe(false);
  });

  it("evaluates select equals by option id", () => {
    expect(evaluateFilter("single_select", "opt_a", "equals", "opt_a")).toBe(true);
    expect(evaluateFilter("single_select", "opt_b", "equals", "opt_a")).toBe(false);
  });

  it("evaluates multi_select contains", () => {
    expect(evaluateFilter("multi_select", ["a", "b"], "contains", "a")).toBe(true);
    expect(evaluateFilter("multi_select", ["a"], "contains", "z")).toBe(false);
    expect(evaluateFilter("multi_select", ["a"], "not_contains", "z")).toBe(true);
  });

  it("evaluates multi_select contains", () => {
    expect(evaluateFilter("multi_select", ["opt_1"], "contains", "opt_1")).toBe(true);
  });

  it("compares relation operands by row id (array or legacy single string)", () => {
    expect(evaluateFilter("relation", ["r1", "r2"], "contains", ["r2"])).toBe(true);
    expect(evaluateFilter("relation", ["r1"], "contains", ["r2", "r3"])).toBe(false);
    expect(evaluateFilter("relation", ["r1"], "contains", "r1")).toBe(true);
    expect(evaluateFilter("relation", ["r1"], "contains", "手填标题")).toBe(false);
    expect(evaluateFilter("relation", ["r1", "r2"], "not_contains", ["r3"])).toBe(true);
    expect(evaluateFilter("relation", ["r1"], "not_contains", ["r1"])).toBe(false);
    // 操作数未填：沿用旧行为（非空单元格恒判"不包含"）
    expect(evaluateFilter("relation", ["r1"], "not_contains", [])).toBe(true);
    expect(evaluateFilter("relation", ["r1"], "not_contains", null)).toBe(true);
  });

  it("compares epoch-number timestamps by calendar day", () => {
    const noonMs = new Date(2026, 9, 13, 12, 0, 0).getTime();
    expect(evaluateFilter("created_at", noonMs, "equals", "2026-10-13")).toBe(true);
    expect(evaluateFilter("created_at", Math.floor(noonMs / 1000), "equals", "2026-10-13")).toBe(true);
    expect(evaluateFilter("last_edited_at", noonMs, "lt", "2026-10-14")).toBe(true);
    expect(evaluateFilter("created_at", noonMs, "gt", "2026-10-13")).toBe(false);
  });

  it("evaluates relative date operands against current time", () => {
    const now = new Date();
    const localDay = (offset: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    expect(evaluateFilter("date", localDay(0), "equals", makeRelativeOperand("today"))).toBe(true);
    expect(evaluateFilter("date", localDay(-1), "equals", makeRelativeOperand("today"))).toBe(false);
    expect(evaluateFilter("date", localDay(-1), "equals", makeRelativeOperand("yesterday"))).toBe(true);
    expect(evaluateFilter("date", localDay(1), "equals", makeRelativeOperand("tomorrow"))).toBe(true);
    expect(evaluateFilter("date", localDay(-3), "equals", makeRelativeOperand("past_days", 7))).toBe(true);
    expect(evaluateFilter("date", localDay(-9), "equals", makeRelativeOperand("past_days", 7))).toBe(false);
    expect(evaluateFilter("date", localDay(2), "equals", makeRelativeOperand("next_days", 7))).toBe(true);
    expect(evaluateFilter("date", localDay(0), "lt", makeRelativeOperand("tomorrow"))).toBe(true);
    expect(evaluateFilter("date", localDay(0), "gte", makeRelativeOperand("today"))).toBe(true);
    expect(evaluateFilter("date", localDay(0), "gt", makeRelativeOperand("today"))).toBe(false);
    expect(evaluateFilter("date", localDay(9), "not_equals", makeRelativeOperand("past_days", 7))).toBe(true);
    // 非法/未识别 token 一律不命中
    expect(evaluateFilter("date", localDay(0), "equals", "@rel:nonexistent")).toBe(false);
    expect(evaluateFilter("date", localDay(0), "not_equals", "@rel:nonexistent")).toBe(false);
  });

  it("maps relative tokens to inclusive calendar-day ranges", () => {
    const now = new Date(2026, 9, 15); // 2026-10-15 周四
    const ms = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
    expect(relativeDayRange(makeRelativeOperand("today"), now)).toEqual({
      start: ms(2026, 9, 15),
      end: ms(2026, 9, 15),
    });
    expect(relativeDayRange(makeRelativeOperand("yesterday"), now)).toEqual({
      start: ms(2026, 9, 14),
      end: ms(2026, 9, 14),
    });
    expect(relativeDayRange(makeRelativeOperand("this_week"), now)).toEqual({
      start: ms(2026, 9, 12),
      end: ms(2026, 9, 18),
    });
    expect(relativeDayRange(makeRelativeOperand("last_week"), now)).toEqual({
      start: ms(2026, 9, 5),
      end: ms(2026, 9, 11),
    });
    expect(relativeDayRange(makeRelativeOperand("next_week"), now)).toEqual({
      start: ms(2026, 9, 19),
      end: ms(2026, 9, 25),
    });
    expect(relativeDayRange(makeRelativeOperand("this_month"), now)).toEqual({
      start: ms(2026, 9, 1),
      end: ms(2026, 9, 31),
    });
    expect(relativeDayRange(makeRelativeOperand("next_month"), now)).toEqual({
      start: ms(2026, 10, 1),
      end: ms(2026, 10, 30),
    });
    expect(relativeDayRange(makeRelativeOperand("past_days", 7), now)).toEqual({
      start: ms(2026, 9, 9),
      end: ms(2026, 9, 15),
    });
    expect(relativeDayRange(makeRelativeOperand("next_days", 7), now)).toEqual({
      start: ms(2026, 9, 15),
      end: ms(2026, 9, 21),
    });
    expect(relativeDayRange("@rel:past_days:0", now)).toBeNull();
    expect(relativeDayRange("@rel:past_days", now)).toBeNull();
    expect(relativeDayRange("2026-10-15", now)).toBeNull();
  });
});

describe("applyFilters", () => {
  const rows = [row("a"), row("b"), row("c")];
  const cells = cellsOf({
    a: { t: "alpha", n: 1, c: true },
    b: { t: "beta", n: 5, c: false },
    c: { t: "zulu", n: 9, c: true },
  });
  const fields = [field("t", "text"), field("n", "number"), field("c", "checkbox")];

  it("AND combines filters", () => {
    const filters: FilterSpec[] = [
      { id: "f1", field_id: "t", op: "contains", value: "a" },
      { id: "f2", field_id: "c", op: "checked", value: null },
    ];
    expect(applyFilters(rows, cells, filters, fields, "and").map((r) => r.id)).toEqual(["a"]);
  });

  it("OR combines filters", () => {
    const filters: FilterSpec[] = [
      { id: "f1", field_id: "t", op: "contains", value: "beta" },
      { id: "f2", field_id: "n", op: "gt", value: 8 },
    ];
    expect(applyFilters(rows, cells, filters, fields, "or").map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("no filters returns all rows", () => {
    expect(applyFilters(rows, cells, [], fields, "and")).toEqual(rows);
  });

  it("unknown field is ignored (passes)", () => {
    const filters: FilterSpec[] = [{ id: "f1", field_id: "ghost", op: "is_empty", value: null }];
    expect(applyFilters(rows, cells, filters, fields, "and")).toEqual(rows);
  });
});

describe("opsForType / defaultOperand", () => {
  it("provides per-type operator sets", () => {
    expect(opsForType("checkbox")).toEqual(["checked", "unchecked"]);
    expect(opsForType("multi_select")).toContain("contains");
    expect(opsForType("number")).toContain("gt");
    expect(opsForType("text")).toContain("contains");
    expect(opsForType("single_select")).not.toContain("gt");
  });

  it("default operand picks first select option", () => {
    const f = field(
      "s",
      "single_select",
      JSON.stringify({ kind: "select", options: [{ id: "o1", name: "A", color: "blue" }] }),
    );
    expect(defaultOperand(f)).toBe("o1");
    expect(defaultOperand(field("t", "text"))).toBeNull();
  });
});

describe("canGroupBy", () => {
  it("skips two-value checkboxes and system-maintained timestamps", () => {
    expect(canGroupBy(field("s", "single_select"))).toBe(true);
    expect(canGroupBy(field("t", "text"))).toBe(true);
    expect(canGroupBy(field("c", "created_at"))).toBe(true);
    expect(canGroupBy(field("b", "checkbox"))).toBe(false);
    expect(canGroupBy(field("e", "last_edited_at"))).toBe(false);
  });
});

describe("groupRowsForGrid", () => {
  const options = JSON.stringify({
    kind: "select",
    options: [
      { id: "o2", name: "进行中", color: "blue" },
      { id: "o1", name: "待办", color: "gray" },
    ],
  });

  const shape = (groups: GridGroup[]) => groups.map((g) => [g.key, g.label, g.rows.map((r) => r.id)]);

  it("follows option definition order and keeps the empty bucket last", () => {
    const f = field("s", "single_select", options);
    const cells = cellsOf({ r1: { s: "o1" }, r2: { s: "o2" }, r3: { s: null } });
    expect(shape(groupRowsForGrid([row("r1"), row("r2"), row("r3")], cells, f))).toEqual([
      ["o2", "进行中", ["r2"]],
      ["o1", "待办", ["r1"]],
      [UNGROUPED, "", ["r3"]],
    ]);
  });

  it("buckets a stale option id on its own, after the known options", () => {
    const f = field("s", "single_select", options);
    const cells = cellsOf({ r1: { s: "o1" }, r2: { s: "gone" } });
    const groups = groupRowsForGrid([row("r1"), row("r2")], cells, f);
    // 标题取原值，至少不显示成空串
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ["o1", "待办"],
      ["gone", "gone"],
    ]);
  });

  it("keeps a multi-select row in one combined bucket", () => {
    const f = field("m", "multi_select", options);
    const cells = cellsOf({ r1: { m: ["o1", "o2"] }, r2: { m: ["o2", "o1"] }, r3: { m: ["o1"] } });
    const groups = groupRowsForGrid([row("r1"), row("r2"), row("r3")], cells, f);
    // 同一组选项不管录入顺序如何都归一桶：行不会被算两次
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(3);
    const combined = groups.find((g) => g.key === "o2|o1");
    expect(combined?.rows.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(combined?.label).toBe("进行中, 待办");
    expect(groups.find((g) => g.key === "o1")?.label).toBe("待办");
  });

  it("orders numbers by value and text by locale", () => {
    const n = field("n", "number");
    const numCells = cellsOf({ r1: { n: 100 }, r2: { n: 20 }, r3: { n: null } });
    expect(groupRowsForGrid([row("r1"), row("r2"), row("r3")], numCells, n).map((g) => g.key)).toEqual([
      "20.00",
      "100.00",
      UNGROUPED,
    ]);
    const t = field("t", "text");
    const textCells = cellsOf({ r1: { t: "b" }, r2: { t: "a" } });
    expect(groupRowsForGrid([row("r1"), row("r2")], textCells, t).map((g) => g.label)).toEqual(["a", "b"]);
  });

  it("collapses an all-empty column into the ungrouped bucket", () => {
    const t = field("t", "text");
    const groups = groupRowsForGrid([row("r1")], cellsOf({ r1: { t: null } }), t);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: UNGROUPED, rows: [expect.objectContaining({ id: "r1" })] });
    expect(groupRowsForGrid([], cellsOf({}), t)).toEqual([]);
  });
});
