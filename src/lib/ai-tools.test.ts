import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindFakeApp } from "@/test/app-fakes";
import { viewNode } from "@/test/view-node";

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

vi.mock("./database", () => ({ databaseApi: api }));
vi.mock("./db", () => ({ viewApi: view }));
vi.mock("./documents", () => ({ documentApi: { get: () => Promise.resolve(null), save: () => Promise.resolve() } }));

import {
  aiToolSpecs,
  coerceCell,
  resolvePage,
  runRetrievalCall,
  runUndoPlan,
  runWriteAction,
  sanitizeUndoPlan,
} from "./ai-tools";
import { onDatabaseChanged } from "./database-changed";
import type { DatabaseField, FieldType, SelectOption } from "@/types/database";

// 页面树、当前空间与写动作（刷树/改名/失效关联）都由 app-fakes 登记，用例不再 mock 任何 store
const app = bindFakeApp({ workspaceId: "w1" });

beforeEach(() => {
  app.set({ workspaceId: "w1", viewId: null, tree: [] });
  for (const fn of Object.values(app.actions)) fn.mockClear();
});

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

  it("日期：认得出的写法归一，认不出的按空处理（不把原文落进日期列）", async () => {
    // 斜杠/中文写法补零成 YYYY-MM-DD：交给 new Date 会按本机时区偏移，东八区的 2024/1/5 会落到 1 月 4 日
    expect(await coerceCell(field("date"), "2024/1/5")).toBe("2024-01-05");
    expect(await coerceCell(field("date"), "2024年1月5日")).toBe("2024-01-05");
    // 带时刻的仍归一成 ISO（具体时刻随本机时区变化，只断言格式）
    expect(await coerceCell(field("date"), "2024-01-05 08:30")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(await coerceCell(field("date"), "下周三见")).toBeNull();
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

const tableNode = viewNode("v1", "任务", { layout: "grid" });

describe("AI 写动作的逆操作计划", () => {
  beforeEach(() => {
    app.set({ tree: [tableNode], viewId: null });
    app.actions.reload.mockClear();
    app.actions.invalidateRelations.mockClear();
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
    expect(app.actions.reload).toHaveBeenCalledTimes(2); // 建页刷一次，撤销再刷一次
  });

  it("没指定父页面就挂在当前打开的页之下，没有当前页才落到根", async () => {
    await runWriteAction({ tool: "create_page", args: { title: "新页" } });
    expect(view.create).toHaveBeenLastCalledWith(expect.objectContaining({ parent_id: null }));

    app.set({ viewId: "v1" });
    await runWriteAction({ tool: "create_page", args: { title: "子页" } });
    expect(view.create).toHaveBeenLastCalledWith(expect.objectContaining({ parent_id: "v1" }));
  });

  it("改库会通知正显示这张表的页面，解绑后不再打扰", async () => {
    const seen: string[][] = [];
    const off = onDatabaseChanged((ids) => seen.push(ids));
    await runWriteAction({ tool: "add_database_row", args: { database: "任务" } });
    expect(seen).toEqual([["v1"]]);
    off();
    await runWriteAction({ tool: "delete_database_row", args: { database: "任务", row: "r1" } });
    expect(seen).toHaveLength(1);
    expect(app.actions.invalidateRelations).toHaveBeenCalledWith(["v1"]);
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
    viewNode("p1", "项目立项说明", { aliases: '["计划书","立项材料"]' }),
    viewNode("p2", "计划书", { aliases: "[]" }),
  ];

  beforeEach(() => {
    app.set({ tree: rows });
  });

  it("按 id、别名、标题都能定位到同一页", () => {
    expect(resolvePage("p1")?.id).toBe("p1");
    expect(resolvePage("立项材料")?.id).toBe("p1");
    expect(resolvePage(" 立项材料 ")?.id).toBe("p1");
  });

  it("标题优先于别名：计划书 是 p2 的名字，不落到把它当别名的 p1 上", () => {
    expect(resolvePage("计划书")?.id).toBe("p2");
    // 反过来，只有别名能对上时照样命中
    app.set({ tree: [viewNode("p3", "别的东西"), ...rows] });
    expect(resolvePage("立项材料")?.id).toBe("p1");
  });

  it("歧义不猜：同名两页、别名撞在两页上都返回 null", () => {
    app.set({ tree: [viewNode("p3", "计划书"), ...rows] });
    expect(resolvePage("计划书")).toBeNull();
    app.set({
      tree: [viewNode("p4", "甲", { aliases: '["共用叫法"]' }), viewNode("p5", "乙", { aliases: '["共用叫法"]' })],
    });
    expect(resolvePage("共用叫法")).toBeNull();
  });

  it("模糊匹配也覆盖别名，仍只有一个命中才返回", () => {
    expect(resolvePage("立项")?.id).toBe("p1");
    app.set({
      tree: [viewNode("p6", "甲", { aliases: '["季度复盘"]' }), viewNode("p7", "乙", { aliases: "[]" })],
    });
    expect(resolvePage("复盘")?.id).toBe("p6");
    expect(resolvePage("不存在的叫法")).toBeNull();
    expect(resolvePage("")).toBeNull();
  });
});

// 拆成目录模块后新增的三条接缝用例：搬动之前它们同样没有用例盯着，
// 变异核验（分发漏一条 / coerceCell 落 0 / 同名两页猜第一个）能被现有用例打死，
// 但「撤销不通知界面 / 出口不截断 / 工具表少下发一条」三条改坏后全绿——就是这三条补上的。
describe("拆文件后的三条接缝", () => {
  beforeEach(() => {
    app.set({ workspaceId: "w1", viewId: null, tree: [tableNode] });
    api.listFields.mockResolvedValue([col("f1", "标题"), col("f2", "数量", "number")]);
    api.listRows.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    api.loadCells.mockResolvedValue({ r1: { f1: "旧标题" } });
    for (const fn of [api.setCell, api.setCellsMany, api.purgeRow, api.restoreRow]) fn.mockClear();
    for (const fn of Object.values(app.actions)) fn.mockClear();
  });

  it("撤销「改的若干格」同样通知正显示这张表的页面（与写动作一侧对齐）", async () => {
    const out = await runWriteAction({
      tool: "update_database_row",
      args: { database: "任务", row: "r1", cells: { 标题: "新标题" } },
    });
    const seen: string[][] = [];
    const off = onDatabaseChanged((ids) => seen.push(ids));
    await runUndoPlan(out.undo!);
    off();
    expect(seen).toEqual([["v1"]]);
    expect(app.actions.invalidateRelations).toHaveBeenCalledWith(["v1"]);
  });

  it("检索出口按上限截断，绝不把整棵大树原样塞进上下文", async () => {
    const long = Array.from({ length: 250 }, (_, i) => viewNode("p" + i, "页面" + "名".repeat(40) + i));
    app.set({ tree: long });
    const out = await runRetrievalCall("list_pages", {}, 6000);
    expect(out).toContain("…（已截断");
    expect(out.length).toBeLessThan(6100);
    // 没超上限时不动内容：模型拿到的就是清单本身
    app.set({ tree: [tableNode] });
    expect(await runRetrievalCall("list_pages", {}, 6000)).toBe("- 任务 [id=v1] (grid)");
  });

  it("下发的工具表 11 条动作齐全，少一条模型就少一种能力", () => {
    const specs = aiToolSpecs();
    expect(specs.map((s) => s.function.name).sort()).toEqual(
      [
        "add_database_row",
        "apply_edit",
        "create_page",
        "delete_database_row",
        "get_page_content",
        "list_database_fields",
        "list_pages",
        "query_database",
        "search_workspace",
        "set_page_title",
        "update_database_row",
      ].sort(),
    );
    for (const s of specs) {
      expect(s.type).toBe("function");
      expect(s.function.description.length).toBeGreaterThan(0);
      expect((s.function.parameters as { type: string }).type).toBe("object");
    }
  });
});
