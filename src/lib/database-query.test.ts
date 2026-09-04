import { describe, expect, it } from "vitest";
import {
  applyFilters,
  defaultOperand,
  evaluateFilter,
  isCellEmpty,
  opsForType,
  sortRows,
  type FilterSpec,
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
    const f = field("s", "single_select", JSON.stringify({ kind: "select", options: [{ id: "o1", name: "A", color: "blue" }] }));
    expect(defaultOperand(f)).toBe("o1");
    expect(defaultOperand(field("t", "text"))).toBeNull();
  });
});