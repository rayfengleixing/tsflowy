import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  updateFieldOptions: vi.fn((_id: string, _options: { options: SelectOption[] }): Promise<void> => Promise.resolve()),
  listFields: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  listRows: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  loadCells: vi.fn((): Promise<Record<string, Record<string, unknown>>> => Promise.resolve({})),
  createRow: vi.fn((): Promise<{ id: string }> => Promise.resolve({ id: "r-new" })),
  deleteRow: vi.fn(() => Promise.resolve()),
  restoreRow: vi.fn(() => Promise.resolve()),
  purgeRow: vi.fn(() => Promise.resolve()),
  setCell: vi.fn(() => Promise.resolve()),
  setCellsMany: vi.fn((): Promise<number> => Promise.resolve(0)),
}));

const view = vi.hoisted(() => ({
  create: vi.fn((): Promise<{ id: string }> => Promise.resolve({ id: "v-new" })),
  softDelete: vi.fn(() => Promise.resolve()),
}));

const ws = vi.hoisted(() => ({
  currentWorkspaceId: "w1",
  currentViewId: null as string | null,
  tree: [] as unknown[],
  renameView: vi.fn(() => Promise.resolve()),
  reload: vi.fn(() => Promise.resolve()),
}));

const relation = vi.hoisted(() => ({ invalidate: vi.fn() }));

vi.mock("./database", () => ({ databaseApi: api }));
vi.mock("./db", () => ({ viewApi: view }));
vi.mock("./documents", () => ({ documentApi: { get: () => Promise.resolve(null), save: () => Promise.resolve() } }));
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: { getState: () => ws } }));
vi.mock("@/stores/relation", () => ({ useRelationStore: { getState: () => relation } }));

import { coerceCell, resolvePage, runUndoPlan, runWriteAction, sanitizeUndoPlan } from "./ai-tools";
import { onDatabaseChanged } from "./database-changed";
import type { DatabaseField, FieldType, SelectOption } from "@/types/database";
import type { ViewNode } from "@/types/models";

const field = (type: FieldType, options = "{}"): DatabaseField => ({
  id: "f1",
  database_view_id: "v1",
  name: "字段",
  field_type: type,
  options,
  width: 120,
  is_hidden: 0,
  position: 0,
});

const selectOptions = (names: string[]): string =>
  JSON.stringify({
    kind: "select",
    options: names.map((name, i) => ({ id: `opt${i}`, name, color: "blue" })),
  });

/** 第 n 次下发的选项列表（补建副作用断言用） */
const sentOptions = (n: number): SelectOption[] => api.updateFieldOptions.mock.calls[n][1].options;

beforeEach(() => api.updateFieldOptions.mockClear());

describe("coerceCell", () => {
  it("单选：命中已有选项落 id，未命中则补建选项后落新建 id", async () => {
    const f = field("status", selectOptions(["进行中"]));
    expect(await coerceCell(f, "进行中")).toBe("opt0");
    const created = await coerceCell(f, "待办");
    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
    expect(sentOptions(0).map((o) => o.name)).toEqual(["进行中", "待办"]);
    expect(created).toBe(sentOptions(0)[1].id);
    expect(created).not.toBe("待办"); // 裸名称当 id 会让展示、筛选、对端关联全部对不上
  });

  it("多选：未命中的名称补建为选项 id，同名只补一次", async () => {
    const f = field("multi_select", selectOptions(["甲"]));
    const ids = await coerceCell(f, ["甲", "乙", "乙"]);
    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
    expect(sentOptions(0).map((o) => o.name)).toEqual(["甲", "乙"]);
    expect(ids).toEqual(["opt0", sentOptions(0)[1].id, sentOptions(0)[1].id]);
  });

  it("多选：分隔串按中英逗号顿号拆分，空段丢弃", async () => {
    const f = field("multi_select", selectOptions(["甲", "乙"]));
    expect(await coerceCell(f, "甲，乙、甲,")).toEqual(["opt0", "opt1", "opt0"]);
    expect(api.updateFieldOptions).not.toHaveBeenCalled();
  });

  it("日期：把模型给的散文收成 ISO，解析不出才留原文", async () => {
    expect(await coerceCell(field("date"), "2024-01-05")).toBe("2024-01-05");
    // 具体时刻随本机时区变化，只断言「已归一成 ISO」
    expect(await coerceCell(field("date"), "2024/1/5")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await coerceCell(field("date"), "下周三见")).toBe("下周三见");
  });

  it("数字类剥掉单位与千分位，一个数字都没有时不落 0", async () => {
    expect(await coerceCell(field("number"), "1,234.5 元")).toBe(1234.5);
    expect(await coerceCell(field("progress"), "待定")).toBeNull();
    expect(await coerceCell(field("currency"), "—")).toBeNull();
  });

  it("只读与未支持类型不接受模型的值", async () => {
    for (const type of ["formula", "rollup", "relation"] as FieldType[]) {
      expect(await coerceCell(field(type), "任意")).toBeNull();
    }
  });
});

const col = (id: string, name: string, type: FieldType = "text", options = "{}"): DatabaseField => ({
  id,
  database_view_id: "v1",
  name,
  field_type: type,
  options,
  width: 120,
  is_hidden: 0,
  position: 0,
});

const tableNode = { id: "v1", name: "任务", layout: "table", extra: "{}", children: [] } as unknown as ViewNode;

describe("AI 写动作的逆操作计划", () => {
  beforeEach(() => {
    ws.tree = [tableNode];
    ws.currentViewId = null;
    ws.reload.mockClear();
    relation.invalidate.mockClear();
    api.listFields.mockResolvedValue([col("f1", "标题"), col("f2", "数量", "number")]);
    api.listRows.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    api.loadCells.mockResolvedValue({ r1: { f1: "写周报" }, r2: { f1: "写周报" } });
    api.createRow.mockResolvedValue({ id: "r-new" });
    for (const fn of [api.setCell, api.setCellsMany, api.deleteRow, api.restoreRow, api.purgeRow]) fn.mockClear();
    view.create.mockResolvedValue({ id: "v-new" });
    view.softDelete.mockClear();
  });

  it("改行：记下改前的值，撤销清单按原值盖回", async () => {
    api.loadCells.mockResolvedValue({ r1: { f1: "旧标题" } });
    const out = await runWriteAction({
      tool: "update_database_row",
      args: { database: "任务", row: "r1", cells: { 标题: "新标题" } },
    });
    expect(out.ok).toBe(true);
    expect(api.setCell).toHaveBeenCalledWith("r1", "f1", "新标题");
    expect(out.undo).toEqual({
      kind: "reset_cells",
      database: "v1",
      items: [{ row_id: "r1", field_id: "f1", value: "旧标题" }],
    });
    await runUndoPlan(out.undo!);
    expect(api.setCellsMany).toHaveBeenCalledWith([{ rowId: "r1", fieldId: "f1", value: "旧标题" }]);
  });

  it("行引用可以是全库唯一的单元格文本；命中多行时一行都不许动", async () => {
    api.loadCells.mockResolvedValue({ r1: { f1: "甲" }, r2: { f1: "乙" } });
    const out = await runWriteAction({ tool: "delete_database_row", args: { database: "任务", row: "甲" } });
    expect(api.deleteRow).toHaveBeenCalledWith("r1");
    expect(out.undo).toEqual({ kind: "restore_row", database: "v1", row_id: "r1" });

    api.deleteRow.mockClear();
    api.loadCells.mockResolvedValue({ r1: { f1: "同名" }, r2: { f1: "同名" } });
    const bad = await runWriteAction({ tool: "delete_database_row", args: { database: "任务", row: "同名" } });
    expect(bad.ok).toBe(false);
    expect(api.deleteRow).not.toHaveBeenCalled();
  });

  it("一格都没写成时不算成功，也不留下撤不动的空计划", async () => {
    const out = await runWriteAction({
      tool: "update_database_row",
      args: { database: "任务", row: "r1", cells: { 不存在的字段: "x" } },
    });
    expect(out.ok).toBe(false);
    expect(out.undo).toBeUndefined();
    expect(api.setCell).not.toHaveBeenCalled();
  });

  it("加行的撤销是彻底删掉，删行的撤销是从回收站找回", async () => {
    const added = await runWriteAction({ tool: "add_database_row", args: { database: "任务" } });
    expect(added.undo).toEqual({ kind: "purge_row", database: "v1", row_id: "r-new" });
    await runUndoPlan(added.undo!);
    expect(api.purgeRow).toHaveBeenCalledWith("r-new");

    await runUndoPlan({ kind: "restore_row", database: "v1", row_id: "r1" });
    expect(api.restoreRow).toHaveBeenCalledWith("r1");
  });

  it("建页的撤销是移入回收站并刷新页面树", async () => {
    const out = await runWriteAction({ tool: "create_page", args: { title: "新页" } });
    expect(out.undo).toEqual({ kind: "remove_view", view_id: "v-new" });
    await runUndoPlan(out.undo!);
    expect(view.softDelete).toHaveBeenCalledWith("v-new");
    expect(ws.reload).toHaveBeenCalledTimes(2); // 建页刷一次，撤销再刷一次
  });

  it("改库会通知正显示这张表的页面，解绑后不再打扰", async () => {
    const seen: string[][] = [];
    const off = onDatabaseChanged((ids) => seen.push(ids));
    await runWriteAction({ tool: "add_database_row", args: { database: "任务" } });
    expect(seen).toEqual([["v1"]]);
    off();
    await runWriteAction({ tool: "delete_database_row", args: { database: "任务", row: "r1" } });
    expect(seen).toHaveLength(1);
    expect(relation.invalidate).toHaveBeenCalledWith(["v1"]);
  });
});

describe("sanitizeUndoPlan", () => {
  it("认识的动作原样恢复", () => {
    expect(sanitizeUndoPlan({ kind: "purge_row", database: "v1", row_id: "r1" })).toEqual({
      kind: "purge_row",
      database: "v1",
      row_id: "r1",
    });
    expect(
      sanitizeUndoPlan({ kind: "reset_cells", database: "v1", items: [{ row_id: "r1", field_id: "f1", value: null }] }),
    ).toEqual({ kind: "reset_cells", database: "v1", items: [{ row_id: "r1", field_id: "f1", value: null }] });
  });

  it("形状不对、缺 id、条目全脏都按不可撤销处理", () => {
    expect(sanitizeUndoPlan(undefined)).toBeUndefined();
    expect(sanitizeUndoPlan("purge_row")).toBeUndefined();
    expect(sanitizeUndoPlan({ kind: "drop_table", database: "v1" })).toBeUndefined();
    expect(sanitizeUndoPlan({ kind: "purge_row", database: "v1" })).toBeUndefined();
    expect(sanitizeUndoPlan({ kind: "rename_view", view_id: "v1", name: "" })).toBeUndefined();
    expect(
      sanitizeUndoPlan({ kind: "reset_cells", database: "v1", items: [{ row_id: "", field_id: "f1", value: "x" }] }),
    ).toBeUndefined();
    expect(
      sanitizeUndoPlan({ kind: "reset_cells", database: "v1", items: [{ row_id: "r1", field_id: "f1", value: {} }] }),
    ).toBeUndefined();
  });
});

describe("resolvePage 认页面别名", () => {
  const rows = [
    { id: "p1", name: "项目立项说明", aliases: '["计划书","立项材料"]', children: [] },
    { id: "p2", name: "计划书", aliases: "[]", children: [] },
  ];

  beforeEach(() => {
    ws.tree = rows;
  });

  it("按 id、别名、标题都能定位到同一页", () => {
    expect(resolvePage("p1")?.id).toBe("p1");
    expect(resolvePage("立项材料")?.id).toBe("p1");
    expect(resolvePage(" 立项材料 ")?.id).toBe("p1");
  });

  it("标题优先于别名：计划书 是 p2 的名字，不落到把它当别名的 p1 上", () => {
    expect(resolvePage("计划书")?.id).toBe("p2");
    // 反过来，只有别名能对上时照样命中
    ws.tree = [{ id: "p3", name: "别的东西", aliases: "[]", children: [] }, ...rows];
    expect(resolvePage("立项材料")?.id).toBe("p1");
  });

  it("歧义不猜：同名两页、别名撞在两页上都返回 null", () => {
    ws.tree = [{ id: "p3", name: "计划书", aliases: "[]", children: [] }, ...rows];
    expect(resolvePage("计划书")).toBeNull();
    ws.tree = [
      { id: "p4", name: "甲", aliases: '["共用叫法"]', children: [] },
      { id: "p5", name: "乙", aliases: '["共用叫法"]', children: [] },
    ];
    expect(resolvePage("共用叫法")).toBeNull();
  });

  it("模糊匹配也覆盖别名，仍只有一个命中才返回", () => {
    expect(resolvePage("立项")?.id).toBe("p1");
    ws.tree = [
      { id: "p6", name: "甲", aliases: '["季度复盘"]', children: [] },
      { id: "p7", name: "乙", aliases: "[]", children: [] },
    ];
    expect(resolvePage("复盘")?.id).toBe("p6");
    expect(resolvePage("不存在的叫法")).toBeNull();
    expect(resolvePage("")).toBeNull();
  });
});
