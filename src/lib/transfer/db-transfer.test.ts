import { describe, expect, it } from "vitest";
import { parseMarkdownTable, tableToTextMatrix, toMarkdownTable } from "./db-transfer";
import type { DatabaseField, DatabaseRow } from "@/types/database";

const FIELD = (over: Partial<DatabaseField>): DatabaseField => ({
  id: "f1",
  database_view_id: "v1",
  name: "列",
  field_type: "text",
  options: '{"kind":"none"}',
  width: 120,
  is_hidden: 0,
  position: 0,
  ...over,
});

const ROW = (over: Partial<Omit<DatabaseRow, "parent_id">>): DatabaseRow => ({
  id: "r1",
  database_view_id: "v1",
  position: 0,
  document_id: null,
  parent_id: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

describe("数据库表 → 落盘文本矩阵", () => {
  it("选择列写选项名、日期写 ISO 原文（不随机器语言变）", () => {
    const fields = [
      FIELD({ id: "f1", name: "任务", field_type: "text" }),
      FIELD({
        id: "f2",
        name: "状态",
        field_type: "single_select",
        options: JSON.stringify({ kind: "select", options: [{ id: "o1", name: "进行中", color: "blue" }] }),
      }),
      FIELD({ id: "f3", name: "截止", field_type: "date", position: 2 }),
      FIELD({ id: "f4", name: "隐藏列", field_type: "checkbox", is_hidden: 1, position: 3 }),
    ];
    const rows = [ROW({ id: "r1" })];
    const cells = { r1: { f1: "写周报", f2: "o1", f3: "2026-10-20", f4: true } };
    expect(tableToTextMatrix(fields, rows, cells, false)).toEqual([
      ["任务", "状态", "截止"],
      ["写周报", "进行中", "2026-10-20"],
    ]);
    expect(tableToTextMatrix(fields, rows, cells, true)[0]).toEqual(["任务", "状态", "截止", "隐藏列"]);
  });

  it("附件列写文件名，数组列按 ; 连接", () => {
    const fields = [
      FIELD({ id: "f1", name: "附件", field_type: "attachment" }),
      FIELD({ id: "f2", name: "标签", field_type: "multi_select", position: 1, options: '{"kind":"none"}' }),
    ];
    const matrix = tableToTextMatrix(fields, [ROW({ id: "r1" })], {
      r1: { f1: [{ name: "报告.pdf", path: "assets/1.pdf" }], f2: ["a", "b"] },
    });
    expect(matrix[1]).toEqual(["报告.pdf", "a; b"]);
  });

  it("空表只出表头，全空单元格是空串", () => {
    const fields = [FIELD({ id: "f1", name: "列" })];
    expect(tableToTextMatrix(fields, [], {})).toEqual([["列"]]);
    expect(tableToTextMatrix(fields, [ROW({ id: "r1" })], {})[1]).toEqual([""]);
  });
});

describe("Markdown 表格转义与解析", () => {
  it("竖线/反斜杠/换行转义后可以解析回来", () => {
    const matrix = [
      ["列 A", "列 B"],
      ["a|b", "c\\d"],
      ["第一行\n第二行", "x"],
    ];
    const md = toMarkdownTable(matrix);
    expect(parseMarkdownTable(md)).toEqual([
      ["列 A", "列 B"],
      ["a|b", "c\\d"],
      ["第一行\n第二行", "x"],
    ]);
  });

  it("参差的行按最长列补齐", () => {
    expect(parseMarkdownTable(toMarkdownTable([["A", "B", "C"], ["1"]]))).toEqual([
      ["A", "B", "C"],
      ["1", "", ""],
    ]);
  });

  it("没有表格时返回 null", () => {
    expect(parseMarkdownTable("# 标题\n\n普通段落")).toBeNull();
  });

  it("只认第一张表，之后的表格不参与", () => {
    const md = `${toMarkdownTable([["A"], ["1"]])}\n\n| 第二张表 |\n| --- |\n| 2 |`;
    expect(parseMarkdownTable(md)).toEqual([["A"], ["1"]]);
  });
});
