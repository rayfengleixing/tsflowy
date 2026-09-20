import { describe, expect, it } from "vitest";
import {
  buildCsvExport,
  cellToCsv,
  csvValueToCell,
  inferFieldType,
  parseCsv,
  planImport,
  resolveSelectRefs,
  toCsv,
} from "./csv";
import type { DatabaseField, DatabaseRow, SelectOption } from "@/types/database";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\r\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('"a,1","say ""hi""",c')).toEqual([["a,1", 'say "hi"', "c"]]);
  });

  it("handles multiline quoted fields", () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([["line1\nline2", "b"]]);
  });

  it("strips BOM and trailing empty rows", () => {
    expect(parseCsv("\uFEFFa,b\r\n\r\n")).toEqual([["a", "b"]]);
  });

  it("round-trips with toCsv", () => {
    const rows = [
      ["name", "note"],
      ["张三", 'has "quotes", and comma'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("inferFieldType", () => {
  it("detects number / checkbox / date / text", () => {
    expect(inferFieldType(["1", "2.5", "-3"])).toBe("number");
    expect(inferFieldType(["true", "false"])).toBe("checkbox");
    expect(inferFieldType(["2026-08-31", "2026-09-01"])).toBe("date");
    expect(inferFieldType(["hello", "world"])).toBe("text");
    expect(inferFieldType([])).toBe("text");
    expect(inferFieldType(["", ""])).toBe("text");
  });
});

describe("csvValueToCell", () => {
  it("converts per field type", () => {
    expect(csvValueToCell("number", "12.5")).toBe(12.5);
    expect(csvValueToCell("number", "abc")).toBeNull();
    expect(csvValueToCell("number", "")).toBeNull();
    expect(csvValueToCell("checkbox", "true")).toBe(true);
    expect(csvValueToCell("checkbox", "否")).toBe(false);
    expect(csvValueToCell("date", "2026-08-31")).toBe("2026-08-31");
    expect(csvValueToCell("multi_select", "a; b| c")).toEqual(["a", "b", "c"]);
    expect(csvValueToCell("text", "x")).toBe("x");
  });
});

describe("cellToCsv / buildCsvExport", () => {
  const fields: DatabaseField[] = [
    {
      id: "f1",
      database_view_id: "v",
      name: "名称",
      field_type: "text",
      options: "{}",
      width: 180,
      is_hidden: 0,
      position: 0,
    },
    {
      id: "f2",
      database_view_id: "v",
      name: "数量",
      field_type: "number",
      options: "{}",
      width: 180,
      is_hidden: 1,
      position: 1,
    },
    {
      id: "f3",
      database_view_id: "v",
      name: "标签",
      field_type: "multi_select",
      options: "{}",
      width: 180,
      is_hidden: 0,
      position: 2,
    },
  ];
  const rows: DatabaseRow[] = [
    { id: "r1", database_view_id: "v", position: 0, document_id: null, created_at: 0, updated_at: 0 },
  ];
  const cells = { r1: { f1: "苹果", f2: 3, f3: ["水果", "红色"] } };

  it("hides hidden fields and joins multi_select", () => {
    const out = buildCsvExport(fields, rows, cells);
    expect(out).toBe("名称,标签\r\n苹果,水果; 红色\r\n");
    expect(cellToCsv("checkbox", true)).toBe("true");
    expect(cellToCsv("text", null)).toBe("");
  });
});

describe("resolveSelectRefs / 选择类导出", () => {
  const options: SelectOption[] = [
    { id: "o1", name: "水果", color: "green" },
    { id: "o2", name: "蔬菜", color: "blue" },
  ];

  it("maps single select name to option id", () => {
    expect(resolveSelectRefs("single_select", "蔬菜", options)).toEqual({ ids: ["o2"], missing: [] });
    expect(resolveSelectRefs("single_select", "   ", options)).toEqual({ ids: [], missing: [] });
    expect(resolveSelectRefs("single_select", "新品类", options)).toEqual({ ids: [], missing: ["新品类"] });
  });

  it("splits multi select, dedupes ids and reports unknown names", () => {
    expect(resolveSelectRefs("multi_select", "水果; 蔬菜|水果", options)).toEqual({ ids: ["o1", "o2"], missing: [] });
    expect(resolveSelectRefs("multi_select", "水果; 新品类", options)).toEqual({ ids: ["o1"], missing: ["新品类"] });
  });

  it("exports select cells as option names (ids translated back)", () => {
    const selectFields: DatabaseField[] = [
      {
        id: "s1",
        database_view_id: "v",
        name: "类别",
        field_type: "single_select",
        options: JSON.stringify({ kind: "select", options }),
        width: 180,
        is_hidden: 0,
        position: 0,
      },
      {
        id: "m1",
        database_view_id: "v",
        name: "标签",
        field_type: "multi_select",
        options: JSON.stringify({ kind: "select", options }),
        width: 180,
        is_hidden: 0,
        position: 1,
      },
    ];
    const out = buildCsvExport(
      selectFields,
      [
        { id: "r1", database_view_id: "v", position: 0, document_id: null, created_at: 0, updated_at: 0 },
        { id: "r2", database_view_id: "v", position: 1, document_id: null, created_at: 0, updated_at: 0 },
      ],
      { r1: { s1: "o2", m1: ["o1", "x9"] } },
    );
    // 失效 id（x9）原样保留，避免静默丢数据；空单元格导出为空串而不是 "null"
    expect(out).toBe("类别,标签\r\n蔬菜,水果; x9\r\n,\r\n");
  });
});

describe("planImport", () => {
  it("names empty headers and infers types from samples", () => {
    const parsed = [
      ["姓名", "", "数量"],
      ["张三", "x", "1"],
      ["李四", "y", "2.5"],
    ];
    const plan = planImport(parsed);
    expect(plan.headers).toEqual(["姓名", "字段 2", "数量"]);
    expect(plan.types).toEqual(["text", "text", "number"]);
  });

  it("returns empty for empty input", () => {
    expect(planImport([])).toEqual({ headers: [], types: [] });
  });
});
