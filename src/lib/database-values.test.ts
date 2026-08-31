import { describe, expect, it } from "vitest";
import type { FieldOptions } from "@/types/database";
import {
  defaultOptionsFor,
  defaultValue,
  deserializeValue,
  formatCellValue,
  formatNumber,
  newSelectOption,
  parseFieldOptions,
  serializeValue,
  validateCellValue,
} from "./database-values";

describe("serializeValue / deserializeValue", () => {
  it("round-trips all value kinds as JSON", () => {
    const cases: unknown[] = ["hello", 123.45, true, ["a", "b"], null];
    for (const v of cases) {
      expect(deserializeValue("text", serializeValue("text", v as never))).toEqual(v);
    }
  });

  it("returns null for invalid JSON", () => {
    expect(deserializeValue("text", "{not json")).toBeNull();
  });
});

describe("defaultValue", () => {
  it("returns typed defaults per field type", () => {
    expect(defaultValue("checkbox")).toBe(false);
    expect(defaultValue("multi_select")).toEqual([]);
    expect(defaultValue("relation")).toEqual([]);
    expect(defaultValue("text")).toBeNull();
    expect(defaultValue("number")).toBeNull();
    expect(defaultValue("single_select")).toBeNull();
  });
});

describe("validateCellValue", () => {
  it("accepts matching values and rejects wrong types", () => {
    expect(validateCellValue("text", "ok")).toBe(true);
    expect(validateCellValue("text", 42)).toBe(false);
    expect(validateCellValue("number", 3.14)).toBe(true);
    expect(validateCellValue("number", "3.14")).toBe(false);
    expect(validateCellValue("number", Number.NaN)).toBe(false);
    expect(validateCellValue("checkbox", true)).toBe(true);
    expect(validateCellValue("checkbox", "true")).toBe(false);
    expect(validateCellValue("multi_select", ["a"])).toBe(true);
    expect(validateCellValue("multi_select", [1] as never)).toBe(false);
    expect(validateCellValue("single_select", "opt_1")).toBe(true);
    expect(validateCellValue("date", "2026-08-31")).toBe(true);
    expect(validateCellValue("relation", ["row_1"])).toBe(true);
  });

  it("accepts null for every type", () => {
    for (const type of ["text", "number", "date", "checkbox", "multi_select", "relation"] as const) {
      expect(validateCellValue(type, null)).toBe(true);
    }
  });
});

describe("formatNumber", () => {
  it("formats integer / decimal / percent / currency", () => {
    const opts = (format: "integer" | "decimal" | "percent" | "currency"): Extract<FieldOptions, { kind: "number" }> => ({ kind: "number", format, precision: 2, currency: "CNY" });
    expect(formatNumber(12.345, opts("integer"))).toBe("12");
    expect(formatNumber(12.345, opts("decimal"))).toBe("12.35");
    expect(formatNumber(12.5, opts("percent"))).toBe("12.50%");
    expect(formatNumber(12.3, opts("currency"))).toMatch(/¥|CNY/);
  });
});

describe("formatCellValue", () => {
  it("formats checkbox and multi_select", () => {
    expect(formatCellValue("checkbox", true)).toBe("✓");
    expect(formatCellValue("checkbox", false)).toBe("");
    expect(formatCellValue("multi_select", ["a", "b"])).toBe("a, b");
    expect(formatCellValue("multi_select", [])).toBe("");
    expect(formatCellValue("relation", ["r1"])).toBe("1 项");
  });

  it("formats date with and without time", () => {
    const date = "2026-08-31";
    expect(formatCellValue("date", date, { kind: "date", include_time: false })).toBe("2026/8/31");
    expect(formatCellValue("date", date, { kind: "date", include_time: true })).toContain("2026");
  });

  it("maps single_select id to option name", () => {
    const options: Extract<FieldOptions, { kind: "select" }> = { kind: "select", options: [{ id: "o1", name: "进行中", color: "blue" }] };
    expect(formatCellValue("single_select", "o1", options)).toBe("进行中");
    expect(formatCellValue("single_select", "missing", options)).toBe("missing");
  });

  it("handles empty values", () => {
    expect(formatCellValue("text", null)).toBe("");
    expect(formatCellValue("text", "")).toBe("");
  });
});

describe("parseFieldOptions / defaultOptionsFor", () => {
  it("parses valid JSON and falls back to none", () => {
    expect(parseFieldOptions('{"kind":"select","options":[]}')).toEqual({ kind: "select", options: [] });
    expect(parseFieldOptions("garbage")).toEqual({ kind: "none" });
    expect(parseFieldOptions(null)).toEqual({ kind: "none" });
  });

  it("provides type-appropriate defaults", () => {
    expect(defaultOptionsFor("single_select")).toEqual({ kind: "select", options: [] });
    expect(defaultOptionsFor("number")).toEqual({ kind: "number", format: "decimal", precision: 2, currency: "CNY" });
    expect(defaultOptionsFor("date")).toEqual({ kind: "date", include_time: false });
    expect(defaultOptionsFor("relation")).toEqual({ kind: "relation", target_view_id: null });
    expect(defaultOptionsFor("text")).toEqual({ kind: "none" });
  });

  it("creates select options with unique ids", () => {
    const a = newSelectOption("待办");
    const b = newSelectOption("待办");
    expect(a.name).toBe("待办");
    expect(a.id).toMatch(/^opt_/);
    expect(a.id).not.toBe(b.id);
  });
});