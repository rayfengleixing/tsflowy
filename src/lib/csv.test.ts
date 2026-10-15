import { describe, expect, it } from "vitest";
import {
  buildCsvExport,
  buildSelectOptions,
  cellToCsv,
  collectSelectNames,
  csvValueToCell,
  inferFieldType,
  importCell,
  parseCsv,
  pasteCell,
  planImport,
  resolveAttachmentNames,
  selectCellToIds,
  toCsv,
} from "./csv";
import type { DatabaseField, DatabaseRow, FieldType, SelectOption } from "@/types/database";
import type { PasteDeps } from "./csv";

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
    expect(parseCsv("﻿a,b\r\n\r\n")).toEqual([["a", "b"]]);
  });

  it("treats a quote in the middle of a field as a literal, not a quote-open", () => {
    // 裸引号曾把状态机带进引用态：逗号被吞、后续行全部粘连
    expect(parseCsv('abc"def,x\ny,2')).toEqual([
      ['abc"def', "x"],
      ["y", "2"],
    ]);
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

  it("keeps leading-zero codes as text so 007 survives the import", () => {
    expect(inferFieldType(["007", "008"])).toBe("text");
    expect(inferFieldType(["010-6666", "021"])).toBe("text");
    expect(inferFieldType(["0", "0.5", "-1"])).toBe("number");
  });

  it("detects url / email / phone columns", () => {
    expect(inferFieldType(["https://example.com/a", "http://b.cn/"])).toBe("url");
    expect(inferFieldType(["a@b.com", "x.y+z@mail.example.org"])).toBe("email");
    expect(inferFieldType(["+86 138 0013 8000", "010-66668888"])).toBe("phone");
    expect(inferFieldType(["(021) 555-8888"])).toBe("phone");
    // 干扰项不误判
    expect(inferFieldType(["hello a@b"])).toBe("text");
    expect(inferFieldType(["1234567"])).toBe("number"); // 纯数字串仍走 number
    expect(inferFieldType(["https://a.com", "note"])).toBe("text");
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
    // 轻量数字类型：progress 去 % 并夹到 0-100，rating 非负，currency 同 number
    expect(csvValueToCell("progress", "65%")).toBe(65);
    expect(csvValueToCell("progress", "120")).toBe(100);
    expect(csvValueToCell("progress", "abc")).toBeNull();
    expect(csvValueToCell("rating", "4")).toBe(4);
    expect(csvValueToCell("rating", "-1")).toBe(0);
    expect(csvValueToCell("currency", "12.5")).toBe(12.5);
    // url/email/phone 存纯文本串（与存储格式一致），只做 trim
    expect(csvValueToCell("url", " https://a.com/x ")).toBe("https://a.com/x");
    expect(csvValueToCell("email", "a@b.com")).toBe("a@b.com");
    expect(csvValueToCell("phone", "+86 138 0013 8000")).toBe("+86 138 0013 8000");
    expect(csvValueToCell("url", "")).toBeNull();
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
    // 附件单元格是 [{name,path}]：导出只写文件名
    expect(cellToCsv("attachment", [{ name: "合同.pdf", path: "assets/1.pdf" }])).toBe("合同.pdf");
    expect(
      cellToCsv("attachment", [
        { name: "a.pdf", path: "assets/1.pdf" },
        { name: "b.png", path: "assets/2.png" },
      ]),
    ).toBe("a.pdf; b.png");
  });

  it("exports attachment field values by file name", () => {
    const attField: DatabaseField = {
      id: "f4",
      database_view_id: "v",
      name: "附件",
      field_type: "attachment",
      options: "{}",
      width: 180,
      is_hidden: 0,
      position: 3,
    };
    const out = buildCsvExport([attField], rows, {
      r1: { f4: [{ name: "合同.pdf", path: "assets/1.pdf" }] },
    });
    expect(out).toBe("附件\r\n合同.pdf\r\n");
  });
});

describe("pasteCell 粘贴/导入一格文本", () => {
  const options: SelectOption[] = [
    { id: "o1", name: "水果", color: "green" },
    { id: "o2", name: "蔬菜", color: "blue" },
  ];
  const mkField = (field_type: FieldType, opts: unknown = { kind: "select", options }): DatabaseField => ({
    id: "f_" + field_type,
    database_view_id: "v",
    name: field_type,
    field_type,
    options: JSON.stringify(opts),
    width: 180,
    is_hidden: 0,
    position: 0,
  });
  /** 建不成的选项补建：等价于改造前「store 拒绝新建」的情形 */
  const failCreate = () => Promise.resolve(null);
  /** 不补建选项、也看不到新字段的极简 deps：等价于改造前「选项已齐全」的情形 */
  const staticDeps: PasteDeps = {
    latestField: () => undefined,
    createOption: failCreate,
  };

  it("值类按类型转成 CellValue", async () => {
    const num = { kind: "number", format: "decimal", precision: 2, currency: "CNY" };
    expect(await pasteCell(mkField("number", num), " 12.5 ", staticDeps)).toEqual({ value: 12.5, degraded: false });
    expect(await pasteCell(mkField("number", num), "abc", staticDeps)).toEqual({ value: null, degraded: false });
    expect(await pasteCell(mkField("progress", num), "65%", staticDeps)).toEqual({ value: 65, degraded: false });
    expect(await pasteCell(mkField("checkbox", { kind: "none" }), "是", staticDeps)).toEqual({
      value: true,
      degraded: false,
    });
    expect(await pasteCell(mkField("checkbox", { kind: "none" }), "", staticDeps)).toEqual({
      value: null,
      degraded: false,
    });
    expect(await pasteCell(mkField("date", { kind: "date", include_time: false }), "2026-08-31", staticDeps)).toEqual({
      value: "2026-08-31",
      degraded: false,
    });
  });

  it("单选命中已有选项写 id，空串写 null", async () => {
    expect(await pasteCell(mkField("single_select"), "蔬菜", staticDeps)).toEqual({ value: "o2", degraded: false });
    expect(await pasteCell(mkField("single_select"), "   ", staticDeps)).toEqual({ value: null, degraded: false });
  });

  it("多选分列去重：已认识的排前面，新建的按创建顺序追加", async () => {
    const created: string[] = [];
    const deps: PasteDeps = {
      latestField: () => undefined,
      createOption: (_fieldId, name) => {
        const id = "new_" + name;
        created.push(id);
        return Promise.resolve(id);
      },
    };
    expect(await pasteCell(mkField("multi_select"), "水果; 新品类|水果", deps)).toEqual({
      value: ["o1", "new_新品类"],
      degraded: false,
    });
    expect(created).toEqual(["new_新品类"]);
  });

  it("补建失败的格：值不完整但照常写入，degraded 交调用方提示", async () => {
    expect(await pasteCell(mkField("single_select"), "新品类", staticDeps)).toEqual({ value: null, degraded: true });
  });

  it("选择类字段没配 options 则整格跳过", async () => {
    expect(await pasteCell(mkField("single_select", { kind: "none" }), "蔬菜", staticDeps)).toBeNull();
  });

  it("文本给不出合法值的类型整格跳过：关联、附件、计算字段、最后编辑时间", async () => {
    const skipTypes: FieldType[] = [
      "relation",
      "attachment",
      "formula",
      "rollup",
      "reverse_relation",
      "last_edited_at",
    ];
    for (const type of skipTypes) {
      expect(await pasteCell(mkField(type, { kind: "none" }), "随便什么", staticDeps), type).toBeNull();
    }
  });

  it("latestField 参与下一格解析：上一格补建的选项不会被重复创建", async () => {
    let live: SelectOption[] = [...options];
    const createdNames: string[] = [];
    const field = mkField("multi_select");
    const deps: PasteDeps = {
      latestField: (id) =>
        id === field.id ? { ...field, options: JSON.stringify({ kind: "select", options: live }) } : undefined,
      createOption: (_fieldId, name) => {
        createdNames.push(name);
        const opt = { id: "opt_" + name, name, color: "gray" };
        live = [...live, opt];
        return Promise.resolve(opt.id);
      },
    };
    expect(await pasteCell(field, "水果; 新品类", deps)).toEqual({ value: ["o1", "opt_新品类"], degraded: false });
    expect(await pasteCell(field, "新品类", deps)).toEqual({ value: ["opt_新品类"], degraded: false });
    expect(createdNames).toEqual(["新品类"]);
  });
});

describe("选择类导出", () => {
  const options: SelectOption[] = [
    { id: "o1", name: "水果", color: "green" },
    { id: "o2", name: "蔬菜", color: "blue" },
  ];

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

describe("CSV 导入选择列（收集名 → 建选项 → 名转 id）", () => {
  it("collectSelectNames 单选整串去重、多选按 ; | 拆分去重", () => {
    expect(collectSelectNames("single_select", ["A", " B ", "A", "", "C"])).toEqual(["A", "B", "C"]);
    expect(collectSelectNames("multi_select", ["a;b", "b|c", "", "a"])).toEqual(["a", "b", "c"]);
  });

  it("buildSelectOptions 每个名生成唯一 id 且顺序稳定", () => {
    const { options, idByName } = buildSelectOptions(["红", "绿", "红"]);
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.name)).toEqual(["红", "绿"]);
    expect(idByName.get("红")).toBe(options[0].id);
    expect(idByName.get("绿")).toBe(options[1].id);
    expect(options[0].id).not.toBe(options[1].id);
  });

  it("selectCellToIds 单选返回 id 串、多选返回 id 数组、空返回 null", () => {
    const { idByName } = buildSelectOptions(["水果", "蔬菜"]);
    expect(selectCellToIds("single_select", "蔬菜", idByName)).toBe(idByName.get("蔬菜"));
    expect(selectCellToIds("multi_select", "水果; 蔬菜|水果", idByName)).toEqual([
      idByName.get("水果"),
      idByName.get("蔬菜"),
    ]);
    expect(selectCellToIds("single_select", "   ", idByName)).toBeNull();
    expect(selectCellToIds("multi_select", "不存在", idByName)).toBeNull();
  });

  it("导入往返：收集 + 建选项 + 转 id 后，值与 buildCsvExport 的按名导出闭环", () => {
    const column = ["水果", "蔬菜; 水果", ""];
    const { idByName } = buildSelectOptions(collectSelectNames("multi_select", column));
    expect(selectCellToIds("multi_select", column[1], idByName)).toEqual([idByName.get("蔬菜"), idByName.get("水果")]);
  });

  it("importCell：选择列按预建名表直译，其余类型走注册表 paste", () => {
    const { idByName } = buildSelectOptions(["水果", "蔬菜"]);
    expect(importCell("single_select", "蔬菜", idByName)).toBe(idByName.get("蔬菜"));
    expect(importCell("multi_select", "水果; 蔬菜", idByName)).toEqual([idByName.get("水果"), idByName.get("蔬菜")]);
    // 非选择列不碰选项表，直接走注册表的文本解读
    expect(importCell("number", "12.5")).toBe(12.5);
    expect(importCell("checkbox", "是")).toBe(true);
    // 附件走「文件名 → assets 复制」另一条链路，纯文本在这里给不出值
    expect(importCell("attachment", "a.png")).toBeNull();
  });
});

describe("resolveAttachmentNames", () => {
  const files: Record<string, string> = {
    "合同.pdf": "C:/docs/合同.pdf",
    "photo.png": "C:/docs/PHOTO.PNG",
  };

  it("按分号/竖线分隔并保留原始文件名", () => {
    expect(resolveAttachmentNames("合同.pdf; photo.png | 报价.xlsx", files)).toEqual({
      matched: [
        { name: "合同.pdf", sourcePath: "C:/docs/合同.pdf" },
        { name: "photo.png", sourcePath: "C:/docs/PHOTO.PNG" },
      ],
      missing: ["报价.xlsx"],
    });
  });

  it("大小写不敏感匹配", () => {
    expect(resolveAttachmentNames("PHOTO.png", files)).toEqual({
      matched: [{ name: "PHOTO.png", sourcePath: "C:/docs/PHOTO.PNG" }],
      missing: [],
    });
    expect(resolveAttachmentNames("hoto", files)).toEqual({ matched: [], missing: ["hoto"] });
  });

  it("未匹配进 missing，空串返回空", () => {
    expect(resolveAttachmentNames("", files)).toEqual({ matched: [], missing: [] });
    expect(resolveAttachmentNames("   ", files)).toEqual({ matched: [], missing: [] });
    expect(resolveAttachmentNames("a;; |b", files)).toEqual({ matched: [], missing: ["a", "b"] });
  });

  it("同一个文件重复出现只算一次（保留首次写法）", () => {
    expect(resolveAttachmentNames("合同.pdf; 合同.pdf|合同.PDF", files)).toEqual({
      matched: [{ name: "合同.pdf", sourcePath: "C:/docs/合同.pdf" }],
      missing: [],
    });
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

  it("infers url / email / phone columns for new-table import", () => {
    const plan = planImport([
      ["官网", "联系邮箱", "电话", "备注"],
      ["https://a.com", "x@y.com", "+86-10-66668888", "hi"],
      ["https://b.cn", "z@y.com", "021-5558888", "ok"],
    ]);
    expect(plan.types).toEqual(["url", "email", "phone", "text"]);
  });

  it("returns empty for empty input", () => {
    expect(planImport([])).toEqual({ headers: [], types: [] });
  });
});
