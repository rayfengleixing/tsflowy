import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_DEPTH,
  UNGROUPED,
  applyFilters,
  canGroupBy,
  countFilterLeaves,
  defaultOperand,
  evaluateFilter,
  groupRowsForGrid,
  groupRowsNested,
  insertFilterNode,
  isCellEmpty,
  isFilterGroup,
  makeRelativeOperand,
  newFilterGroup,
  newFilterLeaf,
  opsForType,
  patchFilterGroupMode,
  patchFilterLeaf,
  pruneFiltersByFields,
  relativeDayRange,
  removeFilterNode,
  sortRows,
  type FilterGroup,
  type FilterNode,
  type FilterSpec,
  type GridGroup,
} from "./database-query";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";

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

describe("嵌套筛选组", () => {
  const rows = [row("a"), row("b"), row("c"), row("d")];
  const cells = cellsOf({
    a: { t: "alpha", n: 1 },
    b: { t: "beta", n: 5 },
    c: { t: "zeta", n: 9 },
    d: { t: "omega", n: 2 },
  });
  const fields = [field("t", "text"), field("n", "number")];
  const leaf = (id: string, fieldId: string, op: FilterSpec["op"], value: CellValue): FilterSpec => ({
    id,
    field_id: fieldId,
    op,
    value,
  });
  const ids = (nodes: FilterNode[], mode: "and" | "or" = "and") =>
    applyFilters(rows, cells, nodes, fields, mode).map((r) => r.id);

  it("组内用自己的 mode，顶层再按顶层 mode 组合", () => {
    const group: FilterGroup = {
      id: "g1",
      mode: "or",
      children: [leaf("f1", "t", "contains", "alp"), leaf("f2", "n", "gt", 8)],
    };
    // 组命中 a、c；「n<6」命中 a、b、d
    expect(ids([group, leaf("f3", "n", "lt", 6)], "and")).toEqual(["a"]);
    expect(ids([group, leaf("f3", "n", "lt", 6)], "or")).toEqual(["a", "b", "c", "d"]);
  });

  it("组可以嵌组：内层 OR、外层 AND", () => {
    const inner: FilterGroup = {
      id: "g2",
      mode: "or",
      children: [leaf("f1", "t", "contains", "eta"), leaf("f2", "n", "gt", 8)],
    };
    const outer: FilterGroup = { id: "g1", mode: "and", children: [inner, leaf("f3", "n", "lt", 6)] };
    // 内层：beta(b) 或 n>8(c)；外层再与 n<6 相交 → 只剩 b
    expect(ids([outer])).toEqual(["b"]);
  });

  it("空组不过滤任何行（否则一个没填完的组会把整表筛空）", () => {
    expect(ids([{ id: "g1", mode: "and", children: [] }, leaf("f2", "n", "gt", 8)])).toEqual(["c"]);
    expect(ids([{ id: "g1", mode: "or", children: [] }])).toEqual(["a", "b", "c", "d"]);
  });

  it("组里引用已删字段的那条恒成立，不拖累同组其它条件", () => {
    const group: FilterGroup = {
      id: "g1",
      mode: "and",
      children: [leaf("f1", "ghost", "equals", "x"), leaf("f2", "n", "gte", 5)],
    };
    expect(ids([group])).toEqual(["b", "c"]);
  });

  it("countFilterLeaves 数叶子不数组", () => {
    const nodes: FilterNode[] = [
      leaf("f1", "n", "gt", 1),
      { id: "g1", mode: "or", children: [leaf("f2", "n", "gt", 4), { id: "g2", mode: "and", children: [] }] },
    ];
    expect(countFilterLeaves(nodes)).toBe(2);
  });
});

describe("筛选树的不可变编辑", () => {
  const f = field("t", "text");
  const tree = (): FilterNode[] => [
    newFilterLeaf("f1", f),
    { ...newFilterGroup("g1"), children: [newFilterLeaf("f2", f), newFilterGroup("g11")] },
  ];

  it("按 id 改叶子：嵌在组里的也改得到，没命中的条目内容不变", () => {
    const base = tree();
    const next = patchFilterLeaf(base, "f2", { op: "not_equals", value: "x" });
    const group = next[1];
    expect(isFilterGroup(group) && group.children[0]).toMatchObject({ id: "f2", op: "not_equals", value: "x" });
    expect(next[0]).toEqual(base[0]);
  });

  it("改组的组合方式：只动命中的那个组", () => {
    const next = patchFilterGroupMode(tree(), "g1", "or");
    expect(isFilterGroup(next[1]) && next[1].mode).toBe("or");
    const inner = next[1];
    expect(isFilterGroup(inner) && isFilterGroup(inner.children[1]) && inner.children[1].mode).toBe("and");
  });

  it("删叶子只去掉一条条件，删组连里面的子组一起走", () => {
    const afterLeaf = removeFilterNode(tree(), "f2");
    expect(isFilterGroup(afterLeaf[1]) && afterLeaf[1].children.map((n) => n.id)).toEqual(["g11"]);
    expect(removeFilterNode(tree(), "g1").map((n) => n.id)).toEqual(["f1"]);
  });

  it("往组里追加节点：parentId 为空即顶层，父组已被删则整棵树不动", () => {
    expect(insertFilterNode(tree(), null, newFilterLeaf("f9", f))).toHaveLength(3);
    const inGroup = insertFilterNode(tree(), "g1", newFilterLeaf("f9", f));
    expect(isFilterGroup(inGroup[1]) && inGroup[1].children).toHaveLength(3);
    expect(insertFilterNode(tree(), "gone", newFilterLeaf("f9", f))).toHaveLength(2);
  });

  it("新叶子按字段类型取默认比较符与操作数，新组默认 AND", () => {
    const sel = field(
      "s",
      "single_select",
      JSON.stringify({ kind: "select", options: [{ id: "o1", name: "A", color: "blue" }] }),
    );
    expect(newFilterLeaf("f1", sel)).toEqual({ id: "f1", field_id: "s", op: "is_empty", value: "o1" });
    expect(newFilterGroup("g1")).toEqual({ id: "g1", mode: "and", children: [] });
  });

  it("删字段时清掉引用它的条件，被掏空的组一并移除", () => {
    const nodes: FilterNode[] = [
      newFilterLeaf("keep", field("a", "text")),
      { ...newFilterGroup("g1"), children: [newFilterLeaf("drop", field("b", "text"))] },
    ];
    expect(pruneFiltersByFields(nodes, new Set(["a"])).map((n) => n.id)).toEqual(["keep"]);
  });
});

describe("多级分组", () => {
  const tag = JSON.stringify({
    kind: "select",
    options: [
      { id: "t1", name: "甲" },
      { id: "t2", name: "乙" },
    ],
  });
  const owner = JSON.stringify({
    kind: "select",
    options: [
      { id: "u1", name: "张三" },
      { id: "u2", name: "李四" },
    ],
  });
  const fields = [field("tag", "single_select", tag), field("owner", "single_select", owner)];
  const rowsAll = [row("r1"), row("r2"), row("r3"), row("r4"), row("r5")];
  const cells = cellsOf({
    r1: { tag: "t2", owner: "u1" },
    r2: { tag: "t1", owner: "u2" },
    r3: { tag: "t1", owner: "u1" },
    r4: { tag: "t1", owner: "u1" },
    r5: { tag: null, owner: "u2" },
  });

  it("逐层下钻：上层桶序不变，每层各自按选项定义顺序", () => {
    const nested = groupRowsNested(rowsAll, cells, fields);
    expect(nested.map((g) => [g.path, g.label])).toEqual([
      ["t1", "甲"],
      ["t2", "乙"],
      [UNGROUPED, ""],
    ]);
    expect(nested[0].subgroups.map((g) => [g.path, g.label])).toEqual([
      ["t1/u1", "张三"],
      ["t1/u2", "李四"],
    ]);
    expect(nested[0].subgroups[0].rows.map((r) => r.id)).toEqual(["r3", "r4"]);
  });

  it("父组的 rows 含全部下层行，path 逐层加前缀", () => {
    const nested = groupRowsNested(rowsAll, cells, fields);
    expect(nested[0].rows.map((r) => r.id)).toEqual(["r2", "r3", "r4"]);
    expect(nested[0].depth).toBe(0);
    expect(nested[0].subgroups[0].depth).toBe(1);
    expect(nested[0].subgroups[0].path).toBe("t1/u1");
  });

  it("上层没填值不影响下层分组", () => {
    const empty = groupRowsNested(rowsAll, cells, fields)[2];
    expect(empty.key).toBe(UNGROUPED);
    expect(empty.subgroups.map((g) => g.path)).toEqual([UNGROUPED + "/u2"]);
  });

  it("只给一个字段等同单层分组；字段列表为空或没有行时不出组", () => {
    const one = groupRowsNested(rowsAll, cells, [fields[0]]);
    expect(one).toHaveLength(3);
    expect(one.every((g) => g.subgroups.length === 0)).toBe(true);
    expect(groupRowsNested(rowsAll, cells, [])).toEqual([]);
    expect(groupRowsNested([], cells, fields)).toEqual([]);
  });

  it("超出层数上限的字段不再下钻", () => {
    const many = Array.from({ length: MAX_GROUP_DEPTH + 2 }, (_, i) => field("f" + i, "text"));
    const nested = groupRowsNested([row("r1")], cellsOf({ r1: { f0: "x" } }), many);
    let node = nested[0];
    while (node.subgroups.length > 0) node = node.subgroups[0];
    expect(node.depth).toBe(MAX_GROUP_DEPTH - 1);
  });

  it("每层各自沿用单层桶序（数字按大小），下层桶取自父组行集", () => {
    const numFields = [
      field("n", "number"),
      field("tag", "single_select", JSON.stringify({ kind: "select", options: [{ id: "t1", name: "甲" }] })),
    ];
    const nested = groupRowsNested(
      [row("r1"), row("r2")],
      cellsOf({ r1: { n: 5, tag: "t1" }, r2: { n: 1, tag: "t1" } }),
      numFields,
    );
    expect(nested.map((g) => g.label)).toEqual(["1.00", "5.00"]);
    expect(nested[1].subgroups.map((g) => g.label)).toEqual(["甲"]);
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
