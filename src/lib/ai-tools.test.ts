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

// 正文与检索都做成可换返回值的替身：拆文件前只读取证那四条分支一次没被测过，
// 需要「这篇文档的正文是什么 / 命中了哪些页」由用例当场摆。
const docs = vi.hoisted(() => ({
  get: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  save: vi.fn((): Promise<void> => Promise.resolve()),
}));

const search = vi.hoisted(() => ({
  search: vi.fn((_workspaceId: string, _input: string, _views: unknown[]): Promise<unknown[]> => Promise.resolve([])),
}));

/** 单篇文档内的片段召回：用它区分「超长正文走了片段这条路」与「直接硬截断」 */
const snippets = vi.hoisted(() => ({
  docSearchSnippets: vi.fn((_viewId: string, _query: string, _limit: number): Promise<string[]> => Promise.resolve([])),
}));

vi.mock("./backend/database", () => ({ databaseApi: api }));
vi.mock("./backend/db", () => ({ viewApi: view }));
vi.mock("./doc/documents", () => ({ documentApi: docs }));
vi.mock("./search/search", () => ({ searchApi: search }));
vi.mock("./ai", () => ({ docSearchSnippets: snippets.docSearchSnippets }));

import {
  aiToolSpecs,
  coerceCell,
  resolvePage,
  runRetrievalCall,
  runUndoPlan,
  runWriteAction,
  sanitizeUndoPlan,
} from "./ai-tools";
import { onDatabaseChanged } from "./database/database-changed";
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

// 只读取证的返回值是原样喂回模型的正文：id 让模型后一步能说清改哪一行、选项名让它别把 id 当文本写回、
// 行 id 表头是 update/delete 的唯一凭据。「返回了非空字符串」这种粗断言挡不住这些格式被改坏。
describe("检索工具喂回模型的正文", () => {
  const docJson = (text: string): string =>
    JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  // 一篇真实页面的正文远不止一个段落，逐个块类型造出来比堆 JSON 字面量好读
  const docOf = (content: unknown[]): string => JSON.stringify({ type: "doc", content });
  const para = (text: string): unknown => ({ type: "paragraph", content: [{ type: "text", text }] });
  const heading = (level: number, text: string): unknown => ({
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  });
  const listItem = (text: string): unknown => ({ type: "listItem", content: [para(text)] });
  const tableCell = (type: string, text: string): unknown => ({ type, content: [para(text)] });

  beforeEach(() => {
    app.set({ workspaceId: "w1", viewId: null, tree: [tableNode] });
    for (const fn of [docs.get, search.search, snippets.docSearchSnippets]) fn.mockReset();
    docs.get.mockResolvedValue(null);
    search.search.mockResolvedValue([]);
    snippets.docSearchSnippets.mockResolvedValue([]);
  });

  it("search_workspace：命中行带页面 id 与布局，<em> 标记和换行不进上下文", async () => {
    search.search.mockResolvedValue([
      { view_id: "v1", title: "任务", icon: null, layout: "grid", snippet: "本<em>周</em>完成\n下周见", row_id: "r1" },
      { view_id: "p1", title: "", icon: null, layout: "document", snippet: "", row_id: null },
      { view_id: "p2", title: "长文", icon: null, layout: "document", snippet: "字".repeat(400), row_id: null },
    ]);
    expect(await runRetrievalCall("search_workspace", { query: " 周 " }, 6000)).toBe(
      "检索到 3 个结果：\n- 任务 [id=v1] (grid)：本周完成 下周见\n- 无标题页面 [id=p1] (document)\n- 长文 [id=p2] (document)：" +
        "字".repeat(200),
    );

    // 只列前 12 条，但计数说的是全部命中：模型据此判断「还要不要再检索一轮」
    search.search.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        view_id: "p" + i,
        title: "页面" + i,
        icon: null,
        layout: "document",
        snippet: "",
        row_id: null,
      })),
    );
    const many = await runRetrievalCall("search_workspace", { query: "页面" }, 6000);
    expect(many.split("\n")).toHaveLength(13);
    expect(many).toContain("检索到 20 个结果：");
    expect(many).not.toContain("页面19");
  });

  it("search_workspace：没关键词 / 没空间 / 零命中 / 不认识的工具各回一句能懂的话", async () => {
    expect(await runRetrievalCall("search_workspace", {}, 6000)).toBe("未提供检索关键词。");
    expect(search.search).not.toHaveBeenCalled();
    app.set({ workspaceId: null });
    expect(await runRetrievalCall("search_workspace", { query: "周" }, 6000)).toBe("当前没有打开的工作区。");
    app.set({ workspaceId: "w1" });
    expect(await runRetrievalCall("search_workspace", { query: "周" }, 6000)).toBe("没有检索到相关内容。");
    expect(await runRetrievalCall("forget_about_it", { query: "周" }, 6000)).toBe("未知的检索工具 forget_about_it。");
  });

  it("检索清单里的行详情页不是页面，不喂给搜索", async () => {
    app.set({
      tree: [viewNode("d1", "周报"), viewNode("rd1", "表里的一行", { extra: '{"row_detail":true}' })],
    });
    await runRetrievalCall("search_workspace", { query: "周报" }, 6000);
    expect(search.search.mock.calls[0][2]).toHaveLength(1);
  });

  it("list_database_fields：隐藏列不喂给模型，选择类带上选项名", async () => {
    api.listFields.mockResolvedValue([
      col("f1", "标题"),
      col("f2", "状态", "status", selectOptions(["待办", "进行中"])),
      { ...col("f3", "内部备注"), is_hidden: 1 },
    ]);
    expect(await runRetrievalCall("list_database_fields", { database: "任务" }, 6000)).toBe(
      "- 标题 [text]\n- 状态 [status]（选项：待办 / 进行中）",
    );
    // 字段全被隐藏等于没有字段：回一句「这个表没有字段」比回空串好懂
    api.listFields.mockResolvedValue([{ ...col("f3", "内部备注"), is_hidden: 1 }]);
    expect(await runRetrievalCall("list_database_fields", { database: "任务" }, 6000)).toBe("这个表没有字段。");
    // 页面本身对不上时不说「没有字段」，免得模型以为表是空的
    expect(await runRetrievalCall("list_database_fields", { database: "没这页" }, 6000)).toBe(
      "找不到页面或表「没这页」。",
    );
  });

  it("query_database：行 id 打头，缺 cell 的行留空列而不是整行漏掉", async () => {
    api.listFields.mockResolvedValue([col("f1", "标题"), col("f2", "状态", "status", selectOptions(["待办"]))]);
    api.listRows.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    api.loadCells.mockResolvedValue({ r1: { f1: "写周报", f2: "opt0" } });
    expect(await runRetrievalCall("query_database", { database: "任务" }, 6000)).toBe(
      ["共 2 行，以下为前 2 行：", "行 id | 标题 | 状态", "r1 | 写周报 | 待办", "r2 |  |"].join("\n"),
    );

    // limit 只管行数，不动表头与计数
    api.listRows.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ id: "r" + i })));
    const limited = await runRetrievalCall("query_database", { database: "任务", limit: 2 }, 6000);
    expect(limited).toContain("共 40 行，以下为前 2 行：");
    expect(limited.split("\n")).toHaveLength(4);
    // 不给 limit、或开口要 200 行，都按 30 行封顶：一次取证不该把整张表灌进上下文
    for (const args of [{}, { limit: 200 }]) {
      const capped = await runRetrievalCall("query_database", { database: "任务", ...args }, 6000);
      expect(capped).toContain("以下为前 30 行");
      expect(capped.split("\n")).toHaveLength(32);
    }
  });

  it("get_page_content：空正文与坏 JSON 都回兜底文案，超长先按片段召回", async () => {
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe("「任务」还没有正文。");
    docs.get.mockResolvedValue("{这不是 json");
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe("「任务」还没有正文。");
    docs.get.mockResolvedValue("   ");
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe("「任务」还没有正文。");
    // 结构齐全、一个字的正文也没写，同样算没正文：喂回一个空串只会让模型以为取证失败
    docs.get.mockResolvedValue(docOf([para("  ")]));
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe("「任务」还没有正文。");

    docs.get.mockResolvedValue(docJson("本周完成三张卡片。"));
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe("本周完成三张卡片。");

    // 超上限且给了 query：用片段检索，别把半截正文当全文喂给模型
    docs.get.mockResolvedValue(docJson("字".repeat(300)));
    snippets.docSearchSnippets.mockResolvedValue(["片段甲", "片段乙"]);
    expect(await runRetrievalCall("get_page_content", { page: "任务", query: "字" }, 100)).toBe("片段甲\n…\n片段乙");
    expect(snippets.docSearchSnippets).toHaveBeenCalledWith("v1", "字", 8);

    // 片段检索空手而归（这篇还没进索引）才退回硬截断
    snippets.docSearchSnippets.mockResolvedValue([]);
    expect(await runRetrievalCall("get_page_content", { page: "任务", query: "字" }, 100)).toBe(
      "字".repeat(100) + "\n…（已截断 200 字）",
    );

    // 没给 query 就不查片段，直接按上限截断
    snippets.docSearchSnippets.mockClear();
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 100)).toBe(
      "字".repeat(100) + "\n…（已截断 200 字）",
    );
    expect(snippets.docSearchSnippets).not.toHaveBeenCalled();
  });

  // 模型是靠「#」「| ```」这些记号认出标题、表格、代码块的，拿到 JSON 大括号只会当正文抄回去；
  // 块之间那个空行也是真内容：少一个换行，列表和表格就粘成一行。
  it("get_page_content：标题/列表/表格/代码块/引用各按 Markdown 形状喂回去", async () => {
    docs.get.mockResolvedValue(
      docOf([
        heading(2, "周报"),
        {
          type: "paragraph",
          content: [
            { type: "text", text: "本周完成" },
            { type: "text", marks: [{ type: "bold" }], text: "三张卡片" },
            { type: "text", text: "。" },
          ],
        },
        { type: "bulletList", content: [listItem("写测试"), listItem("发布")] },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [tableCell("tableHeader", "项目"), tableCell("tableHeader", "状态")] },
            { type: "tableRow", content: [tableCell("tableCell", "周报"), tableCell("tableCell", "进行中")] },
          ],
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const done = true;" }] },
        { type: "blockquote", content: [para("下周继续")] },
      ]),
    );
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe(
      [
        "## 周报",
        "",
        "本周完成**三张卡片**。",
        "",
        "- 写测试",
        "- 发布",
        "",
        "| 项目 | 状态 |",
        "| --- | --- |",
        "| 周报 | 进行中 |",
        "",
        "```ts",
        "const done = true;",
        "```",
        "",
        "> 下周继续",
      ].join("\n"),
    );
  });

  // 正文还有另一种真实存法：顶层直接是块数组、没有 { type: "doc" } 包着。
  // 少那次归一化不会报错，只会让模型拿到一整串 <!-- unsupported block --> 。
  it("get_page_content：正文存成块数组时同样还原成 Markdown", async () => {
    docs.get.mockResolvedValue(JSON.stringify([heading(1, "小结"), para("一段结论")]));
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 6000)).toBe("# 小结\n\n一段结论");
  });

  it("get_page_content：截断按喂回去的正文算，不按库里的 JSON 长度算", async () => {
    // 三个字的内容包在列表结构里有三百多字 JSON：按 JSON 判长度会把这篇当超长文档
    docs.get.mockResolvedValue(
      docOf([{ type: "bulletList", content: [listItem("甲"), listItem("乙"), listItem("丙")] }]),
    );
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 30)).toBe("- 甲\n- 乙\n- 丙");
    expect(snippets.docSearchSnippets).not.toHaveBeenCalled();

    // 真超长时「已截断 N 字」说的也是正文还剩多少字，模型据此判断要不要再来一轮片段检索
    docs.get.mockResolvedValue(docOf([para("字".repeat(120))]));
    expect(await runRetrievalCall("get_page_content", { page: "任务" }, 10)).toBe(
      "字".repeat(10) + "\n…（已截断 110 字）",
    );
  });
});
