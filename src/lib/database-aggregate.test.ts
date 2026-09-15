import { describe, expect, it } from "vitest";
import {
  AGGREGATE_FNS,
  aggregateValue,
  aggregatesForType,
  isAggregateFn,
  normalizeAggregate,
} from "./database-aggregate";
import type { CellValue, DatabaseField } from "@/types/database";

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

const selectField = (id: string, type: DatabaseField["field_type"] = "single_select") =>
  field(id, type, JSON.stringify({ kind: "select", options: [{ id: "o1", name: "进行中", color: "blue" }] }));

const cells = (m: Record<string, Record<string, CellValue>>) => m;

describe("aggregatesForType", () => {
  it("offers arithmetic only where it means something", () => {
    expect(aggregatesForType("number")).toEqual(["count", "filled", "empty", "unique", "sum", "average", "min", "max"]);
    expect(aggregatesForType("checkbox")).toEqual(["count", "checked", "unchecked"]);
    expect(aggregatesForType("date")).toEqual(["count", "filled", "empty", "unique", "min", "max"]);
    expect(aggregatesForType("text")).toEqual(["count", "filled", "empty", "unique"]);
  });

  it("every advertised function is parseable from extra", () => {
    for (const type of ["text", "number", "checkbox", "date"] as const) {
      for (const fn of aggregatesForType(type)) {
        expect(isAggregateFn(fn)).toBe(true);
      }
    }
    expect(AGGREGATE_FNS.every(isAggregateFn)).toBe(true);
  });
});

describe("normalizeAggregate", () => {
  it("keeps a still-valid choice", () => {
    expect(normalizeAggregate("number", "sum")).toBe("sum");
  });

  it("falls back to counting once the field type changed", () => {
    // 列从数字改成文本之后，存量的"求和"不能继续留在菜单里
    expect(normalizeAggregate("text", "sum")).toBe("count");
    expect(normalizeAggregate("text", undefined)).toBeUndefined();
  });
});

describe("aggregateValue", () => {
  const nums = cells({ r1: { n: 10 }, r2: { n: null }, r3: { n: 20 } });
  const ids = ["r1", "r2", "r3"];

  it("counts rows, filled and empty cells", () => {
    const n = field("n", "number");
    expect(aggregateValue("count", n, ids, nums)).toBe("3");
    expect(aggregateValue("filled", n, ids, nums)).toBe("2");
    expect(aggregateValue("empty", n, ids, nums)).toBe("1");
  });

  it("treats empty string and empty array as empty", () => {
    const c = cells({ r1: { t: "" }, r2: { t: [] }, r3: { t: "x" }, r4: { t: 0 } });
    const t = field("t", "text");
    expect(aggregateValue("filled", t, ["r1", "r2", "r3", "r4"], c)).toBe("2");
  });

  it("counts distinct displayed values", () => {
    const c = cells({ r1: { s: "o1" }, r2: { s: "o1" }, r3: { s: null } });
    expect(aggregateValue("unique", selectField("s"), ["r1", "r2", "r3"], c)).toBe("1");
  });

  it("sums and averages numbers ignoring blanks", () => {
    const n = field("n", "number");
    expect(aggregateValue("sum", n, ids, nums)).toBe("30.00");
    expect(aggregateValue("average", n, ids, nums)).toBe("15.00");
    expect(aggregateValue("min", n, ids, nums)).toBe("10.00");
    expect(aggregateValue("max", n, ids, nums)).toBe("20.00");
  });

  it("honours the column's own number format", () => {
    const pct = field(
      "n",
      "number",
      JSON.stringify({ kind: "number", format: "percent", precision: 1, currency: "CNY" }),
    );
    expect(aggregateValue("sum", pct, ids, nums)).toBe("30.0%");
  });

  it("gives up quietly when a value-taking function has no data", () => {
    const n = field("n", "number");
    const blank = cells({ r1: { n: null } });
    expect(aggregateValue("sum", n, ["r1"], blank)).toBe("0");
    expect(aggregateValue("average", n, ["r1"], blank)).toBe("");
    expect(aggregateValue("max", n, [], blank)).toBe("");
    expect(aggregateValue("count", n, [], blank)).toBe("0");
  });

  it("counts checkboxes both ways", () => {
    const c = cells({ r1: { b: true }, r2: { b: false }, r3: { b: null } });
    const b = field("b", "checkbox");
    const ids = ["r1", "r2", "r3"];
    expect(aggregateValue("checked", b, ids, c)).toBe("1");
    expect(aggregateValue("unchecked", b, ids, c)).toBe("2");
  });

  it("picks the earliest and latest date", () => {
    const c = cells({ r1: { d: "2026-03-01" }, r2: { d: "2026-01-05" }, r3: { d: null } });
    const d = field("d", "date");
    const ids = ["r1", "r2", "r3"];
    // 具体分隔符随 locale，年份一定在
    expect(aggregateValue("min", d, ids, c)).toContain("2026");
    expect(aggregateValue("min", d, ids, c)).not.toContain("2026-03");
    expect(aggregateValue("max", d, ids, c)).toContain("2026");
  });
});
