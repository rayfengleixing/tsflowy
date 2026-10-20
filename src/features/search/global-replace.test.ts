import { beforeEach, describe, expect, it, vi } from "vitest";

// 全局替换的编排层：候选页来自 Rust 命令，改写分「打开着走编辑器事务 / 没打开走 JSON 直写」两条路。
// 这里钉住的是分流与落库形状——一旦打开着的页面被 JSON 直写覆盖，用户的编辑就会丢。

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  docGet: vi.fn(),
  docSave: vi.fn(),
  getDocEditors: vi.fn(),
  replaceAllInDoc: vi.fn(),
  countReplaceableInDoc: vi.fn(),
}));

vi.mock("@/lib/invoke", () => ({ invoke: h.invoke }));
vi.mock("@/lib/documents", () => ({ documentApi: { get: h.docGet, save: h.docSave } }));
vi.mock("@/stores/editor", () => ({ getDocEditors: h.getDocEditors }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/features/editor/extensions/find-replace", () => ({
  replaceAllInDoc: h.replaceAllInDoc,
  countReplaceableInDoc: h.countReplaceableInDoc,
}));

import { runGlobalReplace } from "./global-replace";

const body = (value: string) =>
  JSON.stringify({
    type: "doc",
    attrs: { meta: 1 },
    content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.getDocEditors.mockReturnValue([]);
  h.docSave.mockResolvedValue(undefined);
});

describe("runGlobalReplace", () => {
  it("没打开的页面：读库改写后整篇存回，根节点的其余键原样保留", async () => {
    h.invoke.mockResolvedValue([{ view_id: "v1", title: "页面一" }]);
    h.docGet.mockResolvedValue(body("旧名 与 旧名"));
    const report = await runGlobalReplace({ workspaceId: "w1", search: "旧名", replace: "新名", dryRun: false });
    expect(report.replaced).toBe(2);
    expect(report.pages[0]).toEqual({
      viewId: "v1",
      title: "页面一",
      replaced: 2,
      crossFormat: 0,
      protectedTitle: 0,
    });
    const [viewId, content] = h.docSave.mock.calls[0] as unknown as [string, string];
    expect(viewId).toBe("v1");
    expect(JSON.parse(content) as unknown).toEqual({
      type: "doc",
      attrs: { meta: 1 },
      content: [{ type: "paragraph", content: [{ type: "text", text: "新名 与 新名" }] }],
    });
  });

  it("预览模式一处都不写库", async () => {
    h.invoke.mockResolvedValue([{ view_id: "v1", title: "页面一" }]);
    h.docGet.mockResolvedValue(body("旧名"));
    const report = await runGlobalReplace({ workspaceId: "w1", search: "旧名", replace: "新名", dryRun: true });
    expect(report.replaced).toBe(1);
    expect(h.docSave).not.toHaveBeenCalled();
  });

  it("打开着的页面交给编辑器事务，绝不 JSON 直写库（否则会和内存态互相覆盖）", async () => {
    const editor = { isDestroyed: false };
    h.invoke.mockResolvedValue([{ view_id: "v1", title: "页面一" }]);
    h.getDocEditors.mockReturnValue([editor]);
    h.replaceAllInDoc.mockReturnValue(3);
    const report = await runGlobalReplace({
      workspaceId: "w1",
      search: "旧名",
      replace: "新名",
      options: { caseSensitive: true },
      dryRun: false,
    });
    expect(report.replaced).toBe(3);
    expect(h.replaceAllInDoc).toHaveBeenCalledWith(editor, "旧名", "新名", { caseSensitive: true, wholeWord: false });
    expect(h.docGet).not.toHaveBeenCalled();
    expect(h.docSave).not.toHaveBeenCalled();
  });

  it("同一页开在两栏时两个实例都要改到，处数只算一次", async () => {
    const a = { isDestroyed: false };
    const b = { isDestroyed: false };
    h.invoke.mockResolvedValue([{ view_id: "v1", title: "页面一" }]);
    h.getDocEditors.mockReturnValue([a, b]);
    h.replaceAllInDoc.mockReturnValue(2);
    const report = await runGlobalReplace({ workspaceId: "w1", search: "旧名", replace: "新名", dryRun: false });
    expect(h.replaceAllInDoc).toHaveBeenCalledTimes(2);
    expect(report.replaced).toBe(2);
  });

  it("取消后停在当前进度，报告标出 stopped 且不吞掉已改写的页面", async () => {
    h.invoke.mockResolvedValue([
      { view_id: "v1", title: "页面一" },
      { view_id: "v2", title: "页面二" },
    ]);
    h.docGet.mockResolvedValue(body("旧名"));
    let seen = 0;
    const report = await runGlobalReplace({
      workspaceId: "w1",
      search: "旧名",
      replace: "新名",
      dryRun: false,
      isCancelled: () => seen >= 1,
      onProgress: () => {
        seen++;
      },
    });
    expect(report.stopped).toBe(true);
    expect(report.pages.map((p) => p.viewId)).toEqual(["v1"]);
  });

  it("坏文档只跳过该页，其余页面照常改完", async () => {
    h.invoke.mockResolvedValue([
      { view_id: "bad", title: "坏页" },
      { view_id: "v2", title: "页面二" },
    ]);
    h.docGet.mockRejectedValueOnce(new Error("IPC 断了")).mockResolvedValueOnce(body("旧名"));
    const report = await runGlobalReplace({ workspaceId: "w1", search: "旧名", replace: "新名", dryRun: false });
    expect(report.pages.map((p) => p.viewId)).toEqual(["v2"]);
    expect(report.replaced).toBe(1);
  });

  it("空查询不查库，也不给任何页面", async () => {
    const report = await runGlobalReplace({ workspaceId: "w1", search: "", replace: "新名", dryRun: false });
    expect(report.pages).toEqual([]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
