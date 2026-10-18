import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const docGetMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, convertFileSrc: (p: string) => p }));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: {
    getState: () => ({
      tree: [
        {
          id: "root",
          name: "项目",
          layout: "document",
          children: [
            { id: "child", name: "子页", layout: "document", children: [] },
            { id: "board", name: "看板", layout: "board", children: [] },
          ],
        },
        { id: "solo", name: "散页", layout: "document", children: [] },
      ],
    }),
  },
}));
vi.mock("./documents", () => ({ documentApi: { get: docGetMock } }));

import { exportMarkdownFolder } from "./export-folder";
import type { ExportManifest } from "./export-manifest";

const ROOT_DOC = {
  type: "doc",
  content: [{ type: "image", attrs: { src: "assets/a.png", alt: "图一" } }],
};
const CHILD_DOC = {
  type: "doc",
  content: [
    { type: "image", attrs: { src: "assets/a.png", alt: "同图" } },
    { type: "attachment", attrs: { src: "assets/报告.pdf", name: "报告.pdf" } },
  ],
};
const SOLO_DOC = { type: "doc", content: [{ type: "text", text: "无附件" }] };

/** 看板页（layout: board）的库侧数据：一个文本列 + 一个单选列（单元格存选项 id） */
function dbFixture(cmd: string): unknown {
  if (cmd === "field_list") {
    return [
      {
        id: "f1",
        database_view_id: "board",
        name: "任务",
        field_type: "text",
        options: null,
        width: 200,
        is_hidden: 0,
        position: 0,
      },
      {
        id: "f2",
        database_view_id: "board",
        name: "状态",
        field_type: "single_select",
        options: JSON.stringify({ kind: "select", options: [{ id: "o1", name: "进行中", color: "blue" }] }),
        width: 120,
        is_hidden: 0,
        position: 1,
      },
    ];
  }
  if (cmd === "row_list") {
    return [
      {
        id: "r1",
        database_view_id: "board",
        position: 0,
        document_id: null,
        created_at: 0,
        updated_at: 0,
      },
    ];
  }
  if (cmd === "cells_load") {
    return [
      { row_id: "r1", field_id: "f1", value: JSON.stringify("写周报") },
      { row_id: "r1", field_id: "f2", value: JSON.stringify("o1") },
    ];
  }
  return cmd === "read_asset_bytes" ? [9] : undefined;
}

const callsFor = (cmd: string): Record<string, unknown>[] =>
  invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);

describe("exportMarkdownFolder（附件随页面落盘）", () => {
  beforeEach(() => {
    openMock.mockReset();
    invokeMock.mockReset();
    docGetMock.mockReset();
    openMock.mockResolvedValue("D:/out");
    docGetMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "root"
          ? JSON.stringify(ROOT_DOC)
          : id === "child"
            ? JSON.stringify(CHILD_DOC)
            : JSON.stringify(SOLO_DOC),
      ),
    );
    invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "read_asset_bytes" ? [9] : dbFixture(cmd)));
  });

  it("每页的附件复制到该 md 文件同级的 assets/ 子目录", async () => {
    const result = await exportMarkdownFolder();
    expect(result).toEqual({ total: 4, exported: 4, failed: 0 });

    expect(callsFor("write_text_file").map((c) => c.path)).toEqual([
      "D:/out/项目/项目.md",
      "D:/out/项目/子页.md",
      "D:/out/项目/看板.md",
      "D:/out/散页.md",
      "D:/out/.tsflowy-export.json",
    ]);
    const writes = callsFor("write_text_file");
    // 清单给导入端用来把正文里的旧 viewId 对回新建的页面
    const manifest = JSON.parse(String(writes[writes.length - 1]?.content)) as ExportManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.views).toMatchObject({ solo: "散页.md", board: "项目/看板.md", root: "项目/项目.md" });
    expect(callsFor("mkdir_all").map((c) => c.path)).toEqual(["D:/out/项目", "D:/out/项目/assets"]);
    // 子页与父页同目录：父页已复制过的 assets/a.png 不重复复制
    expect(callsFor("write_binary_file").map((c) => c.path)).toEqual([
      "D:/out/项目/assets/a.png",
      "D:/out/项目/assets/报告.pdf",
    ]);
  });

  it("看板页导出整张表（含选择列还原成选项名）与 frontmatter", async () => {
    await exportMarkdownFolder();
    const board = callsFor("write_text_file").find((c) => String(c.path).endsWith("看板.md"));
    const content = String(board?.content);
    expect(content).toContain("layout: board");
    expect(content).toContain("| 任务 | 状态 |");
    expect(content).toContain("| 写周报 | 进行中 |");
  });

  it("文档页写 frontmatter，内嵌数据库块带出整张表", async () => {
    docGetMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "solo"
          ? JSON.stringify({
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "正文" }] },
                { type: "databaseView", attrs: { viewId: "board", name: "看板" } },
              ],
            })
          : id === "root"
            ? JSON.stringify(ROOT_DOC)
            : JSON.stringify(CHILD_DOC),
      ),
    );
    await exportMarkdownFolder();
    const solo = callsFor("write_text_file").find((c) => String(c.path) === "D:/out/散页.md");
    const content = String(solo?.content);
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("title: 散页");
    expect(content).toContain("→[看板](db:board)");
    expect(content).toContain("| 写周报 | 进行中 |");
  });

  it("附件读不到时页面照常导出，不计入失败", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_asset_bytes" ? Promise.reject(new Error("asset file not found")) : Promise.resolve(dbFixture(cmd)),
    );
    const result = await exportMarkdownFolder();
    expect(result).toEqual({ total: 4, exported: 4, failed: 0 });
    expect(callsFor("write_binary_file")).toEqual([]);
  });

  it("取消目录选择时返回 null 且不写任何文件", async () => {
    openMock.mockResolvedValue(null);
    expect(await exportMarkdownFolder()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
