import { describe, expect, it } from "vitest";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { buildXlsxSheet, dateToWallClock, exportFileName, resolveExportCells, xlsxKindOf } from "./table-export";
import type { RelationDb } from "./relation";

const field = (
  id: string,
  type: DatabaseField["field_type"],
  options: unknown = { kind: "none" },
  extra: Partial<DatabaseField> = {},
): DatabaseField => ({
  id,
  database_view_id: "v1",
  name: id,
  field_type: type,
  options: JSON.stringify(options),
  width: 180,
  is_hidden: 0,
  position: 0,
  ...extra,
});

const row = (id: string, position = 0): DatabaseRow => ({
  id,
  database_view_id: "v1",
  position,
  document_id: null,
  parent_id: null,
  created_at: 0,
  updated_at: 0,
});

const cells = (m: Record<string, Record<string, CellValue>>) => m;

/** 目标库：主字段 p 决定行标题 */
const targetDb: RelationDb = {
  fields: [field("p", "text"), field("hidden", "text", { kind: "none" }, { is_hidden: 1 })],
  rows: [row("t1"), row("t2")],
  cells: cells({ t1: { p: "任务甲" }, t2: { p: "任务乙" } }),
};
const relationDbOf = (viewId: string): RelationDb | undefined => (viewId === "tv" ? targetDb : undefined);

describe("resolveExportCells", () => {
  const relationField = field("rel", "relation", { kind: "relation", target_view_id: "tv" });
  const reverseField = field("rev", "reverse_relation", {
    kind: "reverse_relation",
    source_view_id: "sv",
    source_field_id: "r",
  });
  const formulaField = field("calc", "formula", { kind: "formula", formula: "{a}" });
  const fields = [field("a", "text"), relationField, reverseField, formulaField];

  it("关联与反向关系折成对端行标题，分号分隔", () => {
    const out = resolveExportCells(
      fields,
      [row("r1")],
      cells({ r1: { a: "写文档", rel: ["t1", "gone", "t2"] } }),
      cells({ r1: { rev: ["t1"] } }),
      (viewId) => (viewId === "sv" ? targetDb : relationDbOf(viewId)),
    );
    expect(out.r1.a).toBe("写文档");
    // 目标库没有的行降级显示原始 id（与网格内的 relationCellText 同一口径）
    expect(out.r1.rel).toBe("任务甲; gone; 任务乙");
    expect(out.r1.rev).toBe("任务甲");
  });

  it("反向关系为空时不写键，保留原始（空）值", () => {
    const source = cells({ r1: { a: "x" } });
    const out = resolveExportCells(fields, [row("r1")], source, cells({}), relationDbOf);
    expect(out.r1).not.toBe(source.r1); // 有 relation 被改写，所以是副本
    expect(out.r1.rev).toBeUndefined();
  });

  it("公式/汇总取展示值，没有展示值则原样", () => {
    const out = resolveExportCells(
      fields,
      [row("r1"), row("r2")],
      cells({ r1: { calc: null }, r2: { a: "乙" } }),
      cells({ r1: { calc: "12.00" } }),
      relationDbOf,
    );
    expect(out.r1.calc).toBe("12.00");
    // 空关联折成空文本（与 CSV 里的空列一致），未参与计算的列不动
    expect(out.r2.a).toBe("乙");
    expect(out.r2.rel).toBe("");
  });

  it("没有计算列时整张图原样透传，不复制行", () => {
    const source = cells({ r1: { a: "x" } });
    const out = resolveExportCells([field("a", "text")], [row("r1")], source, cells({}), relationDbOf);
    expect(out.r1).toBe(source.r1);
  });
});

describe("xlsxKindOf", () => {
  it("按字段类型给出列种类", () => {
    expect(xlsxKindOf(field("n", "number"))).toBe("number");
    for (const type of ["progress", "rating", "currency"] as const) {
      expect(xlsxKindOf(field(type, type))).toBe("number");
    }
    expect(xlsxKindOf(field("c", "checkbox"))).toBe("bool");
    expect(xlsxKindOf(field("d", "date", { kind: "date", include_time: false }))).toBe("date");
    expect(xlsxKindOf(field("dt", "date", { kind: "date", include_time: true }))).toBe("datetime");
    // 系统时间戳与网格展示同口径：只到日
    expect(xlsxKindOf(field("created_at", "created_at"))).toBe("date");
    expect(xlsxKindOf(field("last_edited_at", "last_edited_at"))).toBe("date");
    // 计算列的 options 不描述值类型，按文本列处理
    expect(xlsxKindOf(field("f", "formula", { kind: "formula", formula: "1" }))).toBe("text");
    expect(xlsxKindOf(field("t", "text"))).toBe("text");
  });

  it("未知/脏 options 的日期列按只到日处理", () => {
    expect(xlsxKindOf(field("d", "date", { kind: "none" }))).toBe("date");
  });
});

describe("dateToWallClock", () => {
  it("无时区后缀按 UTC 解释，再折成本地墙上时间", () => {
    const d = new Date("2026-03-05T21:34:56Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    expect(dateToWallClock("2026-03-05T21:34:56Z", false)).toBe(day);
    expect(dateToWallClock("2026-03-05T21:34:56Z", true)).toBe(
      `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    );
    // 纯日期串与「当日 UTC 零点」等价（沿用网格的解析口径）
    expect(dateToWallClock("2026-03-05", false)).toBe(dateToWallClock("2026-03-05T00:00:00Z", false));
  });

  it("给不出时间的值返回 null", () => {
    expect(dateToWallClock("不是日期", false)).toBeNull();
    expect(dateToWallClock("", false)).toBeNull();
    expect(dateToWallClock(null, true)).toBeNull();
    expect(dateToWallClock(1767225600000, false)).toBeNull();
    expect(dateToWallClock(["a"], false)).toBeNull();
  });
});

describe("buildXlsxSheet", () => {
  it("丢掉隐藏列，值按列种类给真类型", () => {
    const fields = [
      field("a", "text"),
      field("n", "number"),
      field("c", "checkbox", { kind: "none" }, { is_hidden: 1 }),
      field("s", "single_select", {
        kind: "select",
        options: [{ id: "o1", name: "进行中", color: "blue" }],
      }),
      field("att", "attachment"),
      field("ghost", "number", { kind: "none" }, { is_hidden: 1 }),
    ];
    const sheet = buildXlsxSheet(
      "任务表",
      fields,
      [row("r1"), row("r2")],
      cells({
        r1: { a: "甲", n: 3.5, c: true, s: "o1", att: [{ name: "图.png", path: "assets/1.png" }] },
        r2: {},
      }),
    );
    expect(sheet.name).toBe("任务表");
    expect(sheet.columns).toEqual([
      { header: "a", kind: "text" },
      { header: "n", kind: "number" },
      { header: "s", kind: "text" },
      { header: "att", kind: "text" },
    ]);
    expect(sheet.rows[0]).toEqual(["甲", 3.5, "进行中", "图.png"]);
    // 空行导出成整行空格，而不是少几列
    expect(sheet.rows[1]).toEqual([null, null, null, null]);
  });

  it("数字列里的脏值与公式列的数值各归各位", () => {
    const sheet = buildXlsxSheet(
      "s",
      [field("n", "number"), field("f", "formula", { kind: "formula", formula: "{n}" })],
      [row("r1"), row("r2")],
      cells({ r1: { n: "很多", f: 12 }, r2: { n: Number.NaN, f: "#CYCLE" } }),
    );
    // 非数值落空（数字列不做「原文本也能凑合」，Excel 里文本数字比空格更误导）
    expect(sheet.rows[0]).toEqual([null, 12]);
    expect(sheet.rows[1]).toEqual([null, "#CYCLE"]);
  });

  it("日期列给墙上时间文本，解析不了的回落原文", () => {
    const sheet = buildXlsxSheet(
      "s",
      [field("d", "date", { kind: "date", include_time: false })],
      [row("r1"), row("r2")],
      cells({ r1: { d: "2026-01-01" }, r2: { d: "待定" } }),
    );
    expect(sheet.columns).toEqual([{ header: "d", kind: "date" }]);
    expect(sheet.rows[0][0]).toBe("2026-01-01");
    expect(sheet.rows[1][0]).toBe("待定");
  });
});

describe("exportFileName", () => {
  it("替换 Windows 保留字符，空名回落 export", () => {
    expect(exportFileName("任务/2026:Q1", "xlsx")).toBe("任务_2026_Q1.xlsx");
    expect(exportFileName("", "csv")).toBe("export.csv");
    expect(exportFileName("   ", "csv")).toBe("export.csv");
  });
});
