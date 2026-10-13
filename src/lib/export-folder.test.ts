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
    invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "read_asset_bytes" ? [9] : undefined));
  });

  it("每页的附件复制到该 md 文件同级的 assets/ 子目录", async () => {
    const result = await exportMarkdownFolder();
    expect(result).toEqual({ total: 3, exported: 3, failed: 0 });

    expect(callsFor("write_text_file").map((c) => c.path)).toEqual([
      "D:/out/项目/项目.md",
      "D:/out/项目/子页.md",
      "D:/out/散页.md",
    ]);
    expect(callsFor("mkdir_all").map((c) => c.path)).toEqual(["D:/out/项目", "D:/out/项目/assets"]);
    // 子页与父页同目录：父页已复制过的 assets/a.png 不重复复制
    expect(callsFor("write_binary_file").map((c) => c.path)).toEqual([
      "D:/out/项目/assets/a.png",
      "D:/out/项目/assets/报告.pdf",
    ]);
  });

  it("附件读不到时页面照常导出，不计入失败", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_asset_bytes" ? Promise.reject(new Error("asset file not found")) : Promise.resolve(undefined),
    );
    const result = await exportMarkdownFolder();
    expect(result).toEqual({ total: 3, exported: 3, failed: 0 });
    expect(callsFor("write_binary_file")).toEqual([]);
  });

  it("取消目录选择时返回 null 且不写任何文件", async () => {
    openMock.mockResolvedValue(null);
    expect(await exportMarkdownFolder()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
