import { describe, expect, it, vi } from "vitest";
import type { CellValue, DatabaseField, DatabaseRow, FieldType } from "@/types/database";
import { UNGROUPED } from "@/lib/database-query";
import { t } from "@/lib/i18n";
import {
  deriveGridCore,
  deriveGridModel,
  deleteCheckedRows,
  duplicateCheckedRows,
  toggleAllRowsChecked,
  toggleRowChecked,
  type BulkRowEffects,
  type CellGraph,
  type GridDataInput,
  type GridModel,
  type GridUiInput,
} from "./grid-view-model";

const field = (id: string, field_type: FieldType, extra: Partial<DatabaseField> = {}): DatabaseField =>
  ({ id, field_type, is_hidden: 0, options: "{}", ...extra }) as DatabaseField;
const row = (id: string): DatabaseRow => ({ id }) as DatabaseRow;
const graph = (entries: [string, Record<string, CellValue>][]): CellGraph => Object.fromEntries(entries);

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
    groupFieldId: null,
    collapsedGroups: new Set<string>(),
    checkedRows: new Set<string>(),
    aggregates: {},
    ...over,
  };
}

/** 测试里数据与交互状态一把给全；正式代码由适配层分两段 memo（见下面的引用稳定性用例） */
const model = (over: Partial<Input> = {}): GridModel => {
  const i = input(over);
  const { checkedRows, collapsedGroups, aggregates } = i;
  return deriveGridModel(deriveGridCore(i), { checkedRows, collapsedGroups, aggregates });
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
    expect(model({ fields: [field("name", "text")], groupFieldId: "not-exist" }).groupField).toBeNull();
    const changed = model({
      fields: [field("name", "text"), field("tag", "attachment")],
      groupFieldId: "tag",
    });
    expect(changed.groupField).toBeNull();
    expect(changed.groups).toBeNull();
    expect(changed.flatLines.map((l) => l.kind)).toEqual(["row", "row"]);
  });

  it("core 只随数据变：勾选与折叠不触发重排/重分组", () => {
    const i = input({
      fields: [field("name", "text"), field("tag", "single_select")],
      sorts: [{ field_id: "name", dir: "asc" }],
      groupFieldId: "tag",
    });
    const core = deriveGridCore(i);
    const base = { collapsedGroups: new Set<string>(), aggregates: {} };
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
    groupFieldId: "tag",
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
