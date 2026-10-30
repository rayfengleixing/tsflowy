import { describe, expect, it, vi } from "vitest";
import type { CellValue, DatabaseField, DatabaseRow, FieldType } from "@/types/database";
import { UNGROUPED } from "@/lib/database/database-query";
import { t } from "@/lib/i18n";
import {
  collapsedAncestorsOfRow,
  deriveGridCore,
  deriveGridModel,
  deleteCheckedRows,
  duplicateCheckedRows,
  groupPathOfRow,
  planRowDrop,
  toggleAllRowsChecked,
  toggleRowChecked,
  type BulkRowEffects,
  type CellGraph,
  type GridDataInput,
  type GridModel,
  type GridUiInput,
  type RowDropMode,
} from "./grid-view-model";
import type { GridFlatLine } from "./grid-view-helpers";

type HeaderLine = Extract<GridFlatLine, { kind: "header" }>;
type SubtotalLine = Extract<GridFlatLine, { kind: "subtotal" }>;
type RowLine = Extract<GridFlatLine, { kind: "row" }>;

const field = (id: string, field_type: FieldType, extra: Partial<DatabaseField> = {}): DatabaseField =>
  ({ id, field_type, is_hidden: 0, options: "{}", ...extra }) as DatabaseField;
const row = (id: string): DatabaseRow => ({ id }) as DatabaseRow;
const graph = (entries: [string, Record<string, CellValue>][]): CellGraph => Object.fromEntries(entries);
const tagOptions = JSON.stringify({ kind: "select", options: [{ id: "t1", name: "甲" }] });

type Input = GridDataInput & GridUiInput;

function input(over: Partial<Input> = {}): Input {
  return {
    fields: [field("name", "text")],
    rows: [row("r1"), row("r2")],
    cells: {},
    sortableCells: {},
    filters: [],
    filterMode: "and",
    sorts: [],
    groupFieldIds: [],
    collapsedGroups: new Set<string>(),
    collapsedRows: new Set<string>(),
    checkedRows: new Set<string>(),
    aggregates: {},
    ...over,
  };
}

/** 测试里数据与交互状态一把给全；正式代码由适配层分两段 memo（见下面的引用稳定性用例） */
const model = (over: Partial<Input> = {}): GridModel => {
  const i = input(over);
  const { checkedRows, collapsedGroups, collapsedRows, aggregates } = i;
  return deriveGridModel(deriveGridCore(i), { checkedRows, collapsedGroups, collapsedRows, aggregates });
};

describe("派生：可见列与行序", () => {
  it("隐藏列不进可见集合，主列取第一个可见列", () => {
    const m = model({ fields: [field("a", "text", { is_hidden: 1 }), field("b", "text"), field("c", "text")] });
    expect(m.visibleFields.map((f) => f.id)).toEqual(["b", "c"]);
    expect(m.primaryField?.id).toBe("b");
  });

  it("先筛选再排序；空值恒排最后", () => {
    const m = model({
      fields: [field("name", "text"), field("n", "number")],
      rows: [row("r1"), row("r2"), row("r3"), row("r4")],
      sortableCells: graph([
        ["r1", { name: "一", n: 3 }],
        ["r2", { name: "二", n: null }],
        ["r3", { name: "三", n: 1 }],
      ]),
      sorts: [{ field_id: "n", dir: "asc" }],
      filters: [{ id: "f1", field_id: "name", op: "is_not_empty", value: null }],
    });
    // r4 连 name 都没有（稀疏图），被筛掉；r2 值为空排最后
    expect(m.displayRows.map((r) => r.id)).toEqual(["r3", "r1", "r2"]);
    expect(m.displayRowIds).toEqual(["r3", "r1", "r2"]);
  });

  it("筛选/排序读求值图而不是存储图：公式列只有 sortableCells 里有值", () => {
    const m = model({
      fields: [field("name", "text"), field("calc", "formula")],
      rows: [row("r1"), row("r2")],
      cells: graph([
        ["r1", { name: "x" }],
        ["r2", { name: "y" }],
      ]),
      sortableCells: graph([
        ["r1", { name: "x", calc: 10 }],
        ["r2", { name: "y", calc: 20 }],
      ]),
      filters: [{ id: "f1", field_id: "calc", op: "gt", value: 15 }],
    });
    expect(m.displayRows.map((r) => r.id)).toEqual(["r2"]);
  });

  it("分组字段被删除或改成不可分组的类型时回落成不分组", () => {
    expect(model({ fields: [field("name", "text")], groupFieldIds: ["not-exist"] }).groupFields).toEqual([]);
    const changed = model({
      fields: [field("name", "text"), field("tag", "attachment")],
      groupFieldIds: ["tag"],
    });
    expect(changed.groupFields).toEqual([]);
    expect(changed.groups).toBeNull();
    expect(changed.flatLines.map((l) => l.kind)).toEqual(["row", "row"]);
  });

  it("core 只随数据变：勾选与折叠不触发重排/重分组", () => {
    const i = input({
      fields: [field("name", "text"), field("tag", "single_select")],
      sorts: [{ field_id: "name", dir: "asc" }],
      groupFieldIds: ["tag"],
    });
    const core = deriveGridCore(i);
    const base = { collapsedGroups: new Set<string>(), collapsedRows: new Set<string>(), aggregates: {} };
    const a = deriveGridModel(core, { ...base, checkedRows: new Set(["r1"]) });
    const b = deriveGridModel(core, { ...base, checkedRows: new Set(["r1", "r2"]), collapsedGroups: new Set(["x"]) });
    // 同一引用才说明适配层的 useMemo 边界没被打穿
    expect(b.displayRows).toBe(a.displayRows);
    expect(b.groups).toBe(a.groups);
    expect(b.visibleFields).toBe(a.visibleFields);
  });
});

describe("派生：多选集合", () => {
  it("只认可见行：被筛走/删掉的勾选不会残留", () => {
    const m = model({
      fields: [field("name", "text"), field("n", "number")],
      rows: [row("r1"), row("r2"), row("r3")],
      sortableCells: graph([
        ["r1", { n: 1 }],
        ["r2", { n: 9 }],
      ]),
      filters: [{ id: "f1", field_id: "n", op: "lte", value: 5 }],
      checkedRows: new Set(["r1", "r2", "gone"]),
    });
    expect(m.selectedIds).toEqual(["r1"]);
    expect(m.allSelected).toBe(true); // 可见集合只剩 r1 且已勾选
  });

  it("部分勾选不算全选，空表不算全选", () => {
    expect(model({ checkedRows: new Set(["r1"]) }).allSelected).toBe(false);
    const empty = model({ rows: [], checkedRows: new Set(["r1"]) });
    expect(empty.allSelected).toBe(false);
    expect(empty.selectedIds).toEqual([]);
  });
});

describe("派生：分组摊平", () => {
  const options = JSON.stringify({
    kind: "select",
    options: [
      { id: "t1", name: "甲" },
      { id: "t2", name: "乙" },
    ],
  });
  const grouped: Partial<Input> = {
    fields: [field("name", "text"), field("tag", "single_select", { options })],
    rows: [row("r1"), row("r2"), row("r3")],
    cells: graph([
      ["r1", { tag: "t2" }],
      ["r2", { tag: "t1" }],
      ["r3", { tag: null }],
    ]),
    groupFieldIds: ["tag"],
  };

  it("桶按选项定义顺序、空值桶恒最后；组标题用选项名", () => {
    const m = model(grouped);
    expect(m.groups?.map((g) => [g.key, g.label])).toEqual([
      ["t1", "甲"],
      ["t2", "乙"],
      [UNGROUPED, ""],
    ]);
    expect(m.flatLines.map((l) => l.kind)).toEqual(["header", "row", "header", "row", "header", "row"]);
    // 空值桶的标题由 UI 用 i18n 兜底
    const head = m.flatLines.find((l) => l.kind === "header" && l.key === UNGROUPED);
    expect(head?.kind === "header" ? head.label : null).toBe(t("grid.ungrouped"));
  });

  it("分组读存储图而不是求值图：选择列的值只在 cells 里", () => {
    // sortableCells 缺 tag 值也不影响分组（改造前就是这条口径）
    expect(model({ ...grouped, sortableCells: {} }).groups?.map((g) => g.key)).toEqual(["t1", "t2", UNGROUPED]);
  });

  it("折叠的组只留组头；有汇总时每组的尾部追加小计行", () => {
    const collapsed = model({ ...grouped, collapsedGroups: new Set(["t1"]) });
    expect(collapsed.flatLines.map((l) => l.kind)).toEqual(["header", "header", "row", "header", "row"]);
    expect(collapsed.flatLines[0]).toMatchObject({ key: "t1", collapsed: true, count: 1 });

    const withAgg = model({ ...grouped, aggregates: { tag: "count" } });
    expect(withAgg.hasAggregates).toBe(true);
    expect(withAgg.flatLines.map((l) => l.kind)).toEqual([
      "header",
      "row",
      "subtotal",
      "header",
      "row",
      "subtotal",
      "header",
      "row",
      "subtotal",
    ]);
    const sub = withAgg.flatLines.find((l) => l.kind === "subtotal");
    expect(sub?.kind === "subtotal" ? sub.rowIds : null).toEqual(["r2"]);
  });

  it("折叠键随折叠集变化（搜索定位据此重算），不分组时恒空串", () => {
    expect(model(grouped).collapsedKey).toBe("");
    expect(model({ ...grouped, collapsedGroups: new Set(["t2", "t1"]) }).collapsedKey).toBe("t2|t1");
  });

  describe("多级分组摊平", () => {
    const owner = JSON.stringify({
      kind: "select",
      options: [
        { id: "u1", name: "张三" },
        { id: "u2", name: "李四" },
      ],
    });
    const nested: Partial<Input> = {
      fields: [
        field("name", "text"),
        field("tag", "single_select", { options }),
        field("owner", "single_select", { options: owner }),
      ],
      rows: [row("r1"), row("r2"), row("r3"), row("r4")],
      cells: graph([
        ["r1", { tag: "t1", owner: "u2" }],
        ["r2", { tag: "t1", owner: "u1" }],
        ["r3", { tag: "t2", owner: "u1" }],
        ["r4", { tag: "t1", owner: "u1" }],
      ]),
      groupFieldIds: ["tag", "owner"],
    };
    const kinds = (m: GridModel) => m.flatLines.map((l) => l.kind);

    it("组头按层级带 depth，小计在整棵子树末尾", () => {
      const m = model(nested);
      // 甲(t1) → 张三(u1){r2,r4} → 李四(u2){r1} → 乙(t2) → 张三(u1){r3}
      expect(kinds(m)).toEqual(["header", "header", "row", "row", "header", "row", "header", "header", "row"]);
      const heads = m.flatLines.filter((l): l is HeaderLine => l.kind === "header");
      expect(heads.map((l) => [l.key, l.depth, l.label, l.count])).toEqual([
        ["t1", 0, "甲", 3],
        ["t1/u1", 1, "张三", 2],
        ["t1/u2", 1, "李四", 1],
        ["t2", 0, "乙", 1],
        ["t2/u1", 1, "张三", 1],
      ]);
    });

    it("每层都出小计：父层小计覆盖其全部下层行", () => {
      const m = model({ ...nested, aggregates: { name: "count" } });
      const subs = m.flatLines.filter((l): l is SubtotalLine => l.kind === "subtotal");
      expect(subs.map((l) => [l.key, l.rowIds])).toEqual([
        ["t1/u1", ["r2", "r4"]],
        ["t1/u2", ["r1"]],
        ["t1", ["r1", "r2", "r4"]],
        ["t2/u1", ["r3"]],
        ["t2", ["r3"]],
      ]);
    });

    it("折叠按 path 记账：折父层收掉整棵子树，折子层只收自己", () => {
      // 折 t1：只剩 t1 组头 + t2 的子树
      expect(kinds(model({ ...nested, collapsedGroups: new Set(["t1"]) }))).toEqual([
        "header",
        "header",
        "header",
        "row",
      ]);
      expect(kinds(model({ ...nested, collapsedGroups: new Set(["t1/u1"]) }))).toEqual([
        "header",
        "header",
        "header",
        "row",
        "header",
        "header",
        "row",
      ]);
    });

    it("groupPathOfRow 给出从顶层到叶子的折叠链，行不在组里则为空", () => {
      const m = model(nested);
      expect(m.groups ? groupPathOfRow(m.groups, "r1") : null).toEqual(["t1", "t1/u2"]);
      expect(m.groups ? groupPathOfRow(m.groups, "r3") : null).toEqual(["t2", "t2/u1"]);
      expect(m.groups ? groupPathOfRow(m.groups, "ghost") : null).toEqual([]);
      // 单层分组时链就是那一层的 key（与折叠集里存的键一致）
      const one = model(grouped);
      expect(one.groups ? groupPathOfRow(one.groups, "r1") : null).toEqual(["t2"]);
    });
  });

  it("字段类型变了：不在候选里的历史汇总回落成计数", () => {
    const m = model({ fields: [field("name", "text"), field("n", "number")], aggregates: { name: "sum" } });
    expect(m.aggregateOf(field("name", "text"))).toBe("count");
    expect(m.aggregateOf(field("n", "number"))).toBeUndefined();
    // 回落后的计数仍是有效汇总，底部汇总行照常渲染
    expect(m.hasAggregates).toBe(true);
  });

  it("可分组候选只来自可见列", () => {
    const m = model({ fields: [field("tag", "single_select"), field("hidden", "text", { is_hidden: 1 })] });
    expect(m.groupableFields.map((f) => f.id)).toEqual(["tag"]);
  });
});

describe("父子行层级摊平", () => {
  const prow = (id: string, parent_id: string | null = null): DatabaseRow => ({ id, parent_id }) as DatabaseRow;
  // 树形：t1 → c1 → g1，t1 → c2，t2 独立
  const tree: Partial<Input> = {
    fields: [field("name", "text")],
    rows: [prow("t1"), prow("c1", "t1"), prow("g1", "c1"), prow("c2", "t1"), prow("t2")],
  };
  const tag: Partial<Input> = {
    fields: [field("name", "text"), field("tag", "single_select", { options: tagOptions })],
    rows: tree.rows,
    cells: graph([
      ["t1", { tag: "t1" }],
      ["c1", { tag: "t1" }],
    ]),
    groupFieldIds: ["tag"],
  };
  const rowLines = (m: GridModel) => m.flatLines.filter((l): l is RowLine => l.kind === "row");
  const shape = (m: GridModel) => rowLines(m).map((l) => [l.row.id, l.depth, l.hasChildren, l.collapsed]);

  it("一张表没有任何父子关系时行序与条目形状保持原样", () => {
    const m = model({ ...tree, rows: [prow("r1"), prow("r2")] });
    expect(m.flatLines).toEqual([
      { kind: "row", row: prow("r1") },
      { kind: "row", row: prow("r2") },
    ]);
  });

  it("深度优先：父行紧跟它的子树，兄弟行沿用行序", () => {
    expect(shape(model(tree))).toEqual([
      ["t1", 1, true, false],
      ["c1", 2, true, false],
      ["g1", 3, false, false],
      ["c2", 2, false, false],
      ["t2", 1, false, false],
    ]);
  });

  it("折叠父行收掉整棵子树，父行自身仍占一行并标 collapsed", () => {
    expect(shape(model({ ...tree, collapsedRows: new Set(["t1"]) }))).toEqual([
      ["t1", 1, true, true],
      ["t2", 1, false, false],
    ]);
    // 折叠中间层只收它自己下面的子树
    expect(shape(model({ ...tree, collapsedRows: new Set(["c1"]) }))).toEqual([
      ["t1", 1, true, false],
      ["c1", 2, true, true],
      ["c2", 2, false, false],
      ["t2", 1, false, false],
    ]);
  });

  it("折叠键：分组模式记组，未分组模式记折叠的父行", () => {
    expect(model({ ...tree, collapsedRows: new Set(["c1", "t1"]) }).collapsedKey).toBe("c1|t1");
    expect(model({ ...tag, collapsedGroups: new Set(["t1"]) }).collapsedKey).toBe("t1");
  });

  it("分组模式下不按行层级展开（组内顺序沿用行序，条目不带 depth）", () => {
    // 折叠的父行在分组模式里不生效：行的父子关系只用于未分组的树形展开
    const m = model({ ...tag, collapsedRows: new Set(["t1"]) });
    expect(rowLines(m).map((l) => l.row.id)).toEqual(["t1", "c1", "g1", "c2", "t2"]);
    expect(rowLines(m).every((l) => l.depth === undefined)).toBe(true);
  });

  it("collapsedAncestorsOfRow 给出被折叠的祖先链，行不在集合里为空", () => {
    const rows = [prow("t1"), prow("c1", "t1"), prow("g1", "c1")];
    expect(collapsedAncestorsOfRow(rows, new Set(["t1", "c1"]), "g1")).toEqual(["t1", "c1"]);
    expect(collapsedAncestorsOfRow(rows, new Set(["c1"]), "g1")).toEqual(["c1"]);
    expect(collapsedAncestorsOfRow(rows, new Set(["t1"]), "t1")).toEqual([]);
    expect(collapsedAncestorsOfRow(rows, new Set(), "ghost")).toEqual([]);
  });
});

describe("勾选集合的纯操作", () => {
  it("toggleRowChecked 增删且不原地改", () => {
    const prev = new Set(["a"]);
    const added = toggleRowChecked(prev, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect(prev).toEqual(new Set(["a"]));
    expect([...toggleRowChecked(added, "a")]).toEqual(["b"]);
  });

  it("toggleAllRowsChecked：已全选清空，否则收全部可见行（忽略原集合）", () => {
    expect([...toggleAllRowsChecked([row("a"), row("b")], false)].sort()).toEqual(["a", "b"]);
    expect(toggleAllRowsChecked([row("a")], true).size).toBe(0);
  });
});

describe("批量行命令", () => {
  function effects(over: Partial<BulkRowEffects> = {}): BulkRowEffects & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      removeRows: vi.fn(() => {
        calls.push("remove");
        return Promise.resolve(2);
      }),
      duplicateRows: vi.fn(() => {
        calls.push("duplicate");
        return Promise.resolve([row("n1"), row("n2")]);
      }),
      clearChecked: vi.fn(() => calls.push("clear")),
      toast: {
        success: vi.fn((m: string) => calls.push(`ok:${m}`)),
        error: vi.fn((m: string) => calls.push(`err:${m}`)),
      },
      log: vi.fn(() => calls.push("log")),
      ...over,
    };
  }

  it("空勾选不发命令", async () => {
    const fx = effects();
    await deleteCheckedRows([], fx);
    await duplicateCheckedRows([], fx);
    expect(fx.calls).toEqual([]);
  });

  it("删除成功：落库 → 清空勾选 → 按受影响行数提示", async () => {
    const fx = effects();
    await deleteCheckedRows(["r1", "r2"], fx);
    expect(fx.calls).toEqual(["remove", "clear", `ok:${t("row.deletedMany", { count: "2" })}`]);
  });

  it("复制成功：提示条数是新建出来的行数", async () => {
    const fx = effects();
    await duplicateCheckedRows(["r1"], fx);
    expect(fx.calls).toEqual(["duplicate", "clear", `ok:${t("row.duplicated", { count: "2" })}`]);
  });

  it("落库失败：记日志并报错，勾选保留（用户可重试）", async () => {
    const boom = new Error("disk full");
    const failed = effects({ removeRows: vi.fn(() => Promise.reject(boom)) });
    await deleteCheckedRows(["r1"], failed);
    expect(failed.calls).toEqual(["log", `err:${t("error.db", { message: String(boom) })}`]);

    const failedDup = effects({ duplicateRows: vi.fn(() => Promise.reject(boom)) });
    await duplicateCheckedRows(["r1"], failedDup);
    expect(failedDup.calls).toEqual(["log", `err:${t("error.db", { message: String(boom) })}`]);
  });
});

describe("拖拽落点意图", () => {
  const prow = (id: string, parent_id: string | null = null): DatabaseRow => ({ id, parent_id }) as DatabaseRow;
  const tree = [prow("t1"), prow("c1", "t1"), prow("g1", "c1"), prow("c2", "t1"), prow("t2")];
  const drop = (draggingId: string, targetId: string, mode: RowDropMode, rows = tree) =>
    planRowDrop({ rows, draggingId, targetId, mode });

  it("普通拖拽沿用行序搬运：落到目标行当前那个位置", () => {
    expect(drop("t2", "c1", "move")).toEqual({ kind: "reorder", ids: ["t1", "t2", "c1", "g1", "c2"] });
  });

  it("Alt 拖到可当父行的行上 → 改挂父级，行序不动", () => {
    expect(drop("t2", "c1", "nest")).toEqual({ kind: "reparent", rowId: "t2", parentId: "c1" });
  });

  it("Alt 拖到自己的后代上不算嵌套，回落成普通改顺序", () => {
    // t1 的后代是 c1/g1/c2：把它们当父行会成环，此时宁可只做一次 reorder
    expect(drop("t1", "g1", "nest")).toEqual({ kind: "reorder", ids: ["c1", "g1", "t1", "c2", "t2"] });
  });

  it("Alt 拖到会挤爆四层限额的行上同样回落成改顺序", () => {
    const chain = [prow("l1"), prow("l2", "l1"), prow("l3", "l2"), prow("l4", "l3")];
    // l1 下面已经挂满三层，任何行都不能再当它的父行
    expect(drop("l1", "l4", "nest", chain)?.kind).toBe("reorder");
    // 叶子行 l4 往上挂是合法的
    expect(drop("l4", "l2", "nest", chain)).toEqual({ kind: "reparent", rowId: "l4", parentId: "l2" });
  });

  it("拖到自己或不在行集里的行：什么都不做", () => {
    expect(drop("t1", "t1", "move")).toBeNull();
    expect(drop("ghost", "t1", "nest")).toBeNull();
    expect(drop("t1", "ghost", "nest")).toBeNull();
  });
});
