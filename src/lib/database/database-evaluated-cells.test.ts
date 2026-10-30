import { describe, expect, it } from "vitest";
import { computeEvaluatedCells } from "./database-evaluated-cells";
import { applyFilters, sortRows, type FilterSpec, type SortSpec } from "./database-query";
import type { RelationDb } from "./relation";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";

// 回归：Board/Calendar/Timeline 与 Grid 的筛选/排序共用同一条取数管线
// displayRows = sortRows(applyFilters(rows, computeEvaluatedCells(...).sortable, ...), ...)
// （组件层无测试基建——vitest 为 node 环境且不收 .tsx，这里锁死管线级行为）

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
  parent_id: null,
  created_at: 0,
  updated_at: 0,
});

const cellsOf = (m: Record<string, Record<string, CellValue>>): Record<string, Record<string, CellValue>> => m;

const rows = [row("a"), row("b"), row("c")];

/** 三个视图公共路径：原始 cells → enriched sortable → 筛选 → 排序 */
function viewDisplayRows(
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  fields: DatabaseField[],
  filters: FilterSpec[],
  sorts: SortSpec[],
  relationDbOf: (viewId: string) => RelationDb | undefined,
): DatabaseRow[] {
  const sortable = computeEvaluatedCells(rows, cells, fields, relationDbOf).sortable;
  return sortRows(applyFilters(rows, sortable, filters, fields, "and"), sortable, sorts);
}

describe("computeEvaluatedCells：公式列作为筛选/排序输入", () => {
  const fields = [
    field("n", "number"),
    field("dbl", "formula", JSON.stringify({ kind: "formula", formula: "{n} * 2" })),
  ];
  const cells = cellsOf({ a: { n: 5 }, b: { n: 50 }, c: { n: null } });
  const noDb = () => undefined;

  it("公式列空值判断走计算值（raw 恒为空，旧路径 is_not_empty 会全不命中）", () => {
    const filters: FilterSpec[] = [{ id: "f1", field_id: "dbl", op: "is_not_empty", value: null }];
    expect(viewDisplayRows(rows, cells, fields, filters, [], noDb).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("公式列 equals 按计算值命中", () => {
    const filters: FilterSpec[] = [{ id: "f1", field_id: "dbl", op: "equals", value: "10" }];
    expect(viewDisplayRows(rows, cells, fields, filters, [], noDb).map((r) => r.id)).toEqual(["a"]);
  });

  it("公式列排序按数值比较且空值最后", () => {
    const sorts: SortSpec[] = [{ field_id: "dbl", dir: "asc" }];
    expect(viewDisplayRows(rows, cells, fields, [], sorts, noDb).map((r) => r.id)).toEqual(["a", "b", "c"]);
    const desc: SortSpec[] = [{ field_id: "dbl", dir: "desc" }];
    expect(viewDisplayRows(rows, cells, fields, [], desc, noDb).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("无计算列时 sortable 原样复用 cells（GridView 行为零变化）", () => {
    const plain = [field("n", "number")];
    expect(computeEvaluatedCells(rows, cells, plain, noDb).sortable).toBe(cells);
  });
});

describe("computeEvaluatedCells：rollup 列作为筛选/排序输入", () => {
  const fields = [
    field("rel", "relation", JSON.stringify({ kind: "relation", target_view_id: "tv" })),
    field(
      "tot",
      "rollup",
      JSON.stringify({ kind: "rollup", relation_field_id: "rel", target_field_id: "tn", fn: "average" }),
    ),
  ];
  const cells = cellsOf({ a: { rel: ["t1"] }, b: { rel: ["t2"] }, c: { rel: [] } });
  const targetDb: RelationDb = {
    fields: [field("tn", "number")],
    rows: [row("t1"), row("t2")],
    cells: cellsOf({ t1: { tn: 9 }, t2: { tn: 42.5 } }),
  };
  const relationDbOf = (viewId: string) => (viewId === "tv" ? targetDb : undefined);

  it("rollup 展示串在 sortable 里转成数值：42.5 不按字典序排在 9 之后", () => {
    const sortable = computeEvaluatedCells(rows, cells, fields, relationDbOf).sortable;
    expect(sortable.a.tot).toBe(9);
    expect(sortable.b.tot).toBe(42.5);
    const sorts: SortSpec[] = [{ field_id: "tot", dir: "asc" }];
    expect(viewDisplayRows(rows, cells, fields, [], sorts, relationDbOf).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("rollup 的 display 图保留展示文本", () => {
    const display = computeEvaluatedCells(rows, cells, fields, relationDbOf).display;
    expect(display.a.tot).toBe("9.00");
  });

  it("rollup 列筛选（contains 文本 / is_empty）走计算值", () => {
    const filters: FilterSpec[] = [{ id: "f1", field_id: "tot", op: "is_not_empty", value: null }];
    expect(viewDisplayRows(rows, cells, fields, filters, [], relationDbOf).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("computeEvaluatedCells：反向关系列作为筛选/排序输入", () => {
  const fields = [
    field(
      "rev",
      "reverse_relation",
      JSON.stringify({ kind: "reverse_relation", source_view_id: "sv", source_field_id: "srel" }),
    ),
  ];
  const cells = cellsOf({ a: {}, b: {}, c: {} });
  const sourceDb: RelationDb = {
    fields: [field("srel", "relation", JSON.stringify({ kind: "relation", target_view_id: "v1" }))],
    rows: [row("s1"), row("s2")],
    cells: cellsOf({ s1: { srel: ["a"] }, s2: { srel: ["a", "b"] } }),
  };
  const relationDbOf = (viewId: string) => (viewId === "sv" ? sourceDb : undefined);

  it("is_not_empty 命中被来源行指向的行", () => {
    const filters: FilterSpec[] = [{ id: "f1", field_id: "rev", op: "is_not_empty", value: null }];
    expect(viewDisplayRows(rows, cells, fields, filters, [], relationDbOf).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sortable 里值为来源行 id 数组", () => {
    const sortable = computeEvaluatedCells(rows, cells, fields, relationDbOf).sortable;
    expect(sortable.a.rev).toEqual(["s1", "s2"]);
    expect(sortable.c.rev).toEqual([]);
  });
});

describe("computeEvaluatedCells：公式按字段名取数时看得懂被引用的列", () => {
  // 旧实现把原始 cells 直接交给 computeRowFormulas：计算列没有存储值 → 恒为空；
  // 选择列存选项 id、关联列存行 id → 公式比不中、拼出来是一串 UUID。
  const fields = [
    field("rel", "relation", JSON.stringify({ kind: "relation", target_view_id: "tv" })),
    field(
      "st",
      "single_select",
      JSON.stringify({ kind: "select", options: [{ id: "o1", name: "进行中", color: "blue" }] }),
    ),
    field(
      "ms",
      "multi_select",
      JSON.stringify({
        kind: "select",
        options: [
          { id: "m1", name: "重要", color: "red" },
          { id: "m2", name: "紧急", color: "orange" },
        ],
      }),
    ),
    field(
      "tot",
      "rollup",
      JSON.stringify({ kind: "rollup", relation_field_id: "rel", target_field_id: "tn", fn: "average" }),
    ),
    field("sum1", "formula", JSON.stringify({ kind: "formula", formula: "{tot} + 1" })),
    field("tag", "formula", JSON.stringify({ kind: "formula", formula: 'CONCAT({st}, "/", {ms})' })),
    field("hit", "formula", JSON.stringify({ kind: "formula", formula: 'CONTAINS({rel}, "项目甲")' })),
  ];
  const cells = cellsOf({
    a: { rel: ["t1"], st: "o1", ms: ["m1", "m2"] },
    b: { rel: ["t1", "t2"], st: null, ms: [] },
    c: { rel: [], st: null, ms: [] },
  });
  const targetDb: RelationDb = {
    fields: [
      { ...field("tt", "text"), position: 0 },
      { ...field("tn", "number"), position: 1 },
    ],
    rows: [row("t1"), row("t2")],
    cells: cellsOf({ t1: { tt: "项目甲", tn: 9 }, t2: { tt: "项目乙", tn: 4 } }),
  };
  const relationDbOf = (viewId: string) => (viewId === "tv" ? targetDb : undefined);

  it("公式引用 rollup 列拿到算出来的数值", () => {
    const { sortable } = computeEvaluatedCells(rows, cells, fields, relationDbOf);
    expect(sortable.a.sum1).toBe(10); // 9 + 1
    expect(sortable.b.sum1).toBe(7.5); // (9+4)/2 + 1
    // 关联为空 → rollup 未配置出值 → 公式也求不出值（不留假 0）
    expect(sortable.c.sum1 ?? null).toBeNull();
  });

  it("公式引用选择列拿到选项名", () => {
    const { display } = computeEvaluatedCells(rows, cells, fields, relationDbOf);
    expect(display.a.tag).toBe("进行中/重要, 紧急");
    expect(display.b.tag).toBe("/"); // 两列都空 → 只剩字面分隔符
  });

  it("公式引用关联列拿到对端行标题，而不是裸 id", () => {
    const { sortable } = computeEvaluatedCells(rows, cells, fields, relationDbOf);
    expect(sortable.a.hit).toBe(true);
    expect(sortable.b.hit).toBe(true);
    expect(sortable.c.hit).toBe(false);
  });

  it("换算给公式的文本不影响 sortable/display：关联列仍是行 id 数组", () => {
    const { sortable, display } = computeEvaluatedCells(rows, cells, fields, relationDbOf);
    expect(sortable.a.rel).toEqual(["t1"]);
    expect(display.a.rel).toEqual(["t1"]);
    expect(sortable.a.tot).toBe(9);
    expect(display.a.tot).toBe("9.00");
  });

  it("公式引用反向关系列拿到来源行标题", () => {
    const revFields = [
      field(
        "rev",
        "reverse_relation",
        JSON.stringify({ kind: "reverse_relation", source_view_id: "sv", source_field_id: "srel" }),
      ),
      field("has", "formula", JSON.stringify({ kind: "formula", formula: 'CONTAINS({rev}, "来源乙")' })),
    ];
    const sourceDb: RelationDb = {
      fields: [
        { ...field("stt", "text"), position: 0 },
        { ...field("srel", "relation", JSON.stringify({ kind: "relation", target_view_id: "v1" })), position: 1 },
      ],
      rows: [row("s1"), row("s2")],
      cells: cellsOf({ s1: { stt: "来源甲", srel: ["a"] }, s2: { stt: "来源乙", srel: ["a", "b"] } }),
    };
    const out = computeEvaluatedCells(rows, cellsOf({ a: {}, b: {}, c: {} }), revFields, (v) =>
      v === "sv" ? sourceDb : undefined,
    );
    expect(out.sortable.a.has).toBe(true);
    expect(out.sortable.b.has).toBe(true);
    expect(out.sortable.c.has).toBe(false);
    // 排序/筛选那侧照旧拿到来源行 id 数组
    expect(out.sortable.a.rev).toEqual(["s1", "s2"]);
  });

  it("没有公式字段时不做任何额外取数", () => {
    const noFormula = fields.slice(0, 4);
    const out = computeEvaluatedCells(rows, cells, noFormula, relationDbOf);
    expect(out.sortable.a.rel).toEqual(["t1"]);
    expect(out.sortable.a.st).toBe("o1");
  });
});
