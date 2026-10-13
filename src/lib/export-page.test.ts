import { beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());
const docGetMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock, open: openMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: writeMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, convertFileSrc: (p: string) => p }));
vi.mock("html-to-image", () => ({ toBlob: vi.fn() }));
vi.mock("@/stores/editor", () => ({ useEditorStore: { getState: () => ({ editor: null }) } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./documents", () => ({ documentApi: { get: docGetMock } }));

import { exportPage } from "./export-page";

const RICH_DOC = {
  type: "doc",
  content: [
    { type: "math", attrs: { tex: "E=mc^2" } },
    { type: "mermaid", attrs: { code: "graph LR\n  A-->B" } },
    { type: "attachment", attrs: { src: "assets/报告.pdf", name: "报告.pdf" } },
    { type: "databaseView", attrs: { viewId: "db-1", name: "任务表" } },
    {
      type: "toggle",
      attrs: { collapsed: false },
      content: [
        { type: "paragraph", content: [{ type: "text", text: "折叠标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "折叠内容" }] },
      ],
    },
    {
      type: "callout",
      attrs: { emoji: "⚠️", color: "yellow" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "注意" }] }],
    },
    {
      type: "columns",
      content: [
        { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "左栏" }] }] },
        { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "右栏" }] }] },
      ],
    },
    { type: "imageGallery", content: [{ type: "image", attrs: { src: "assets/a.png", alt: "图一" } }] },
    { type: "outline" },
    { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script>" }] },
  ],
};

/** 附件复制走 read_asset_bytes + mkdir_all + write_binary_file：missing 里的路径模拟磁盘文件已丢 */
function mockAssetCommands(missing: string[] = []) {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_asset_bytes") {
      const relative = String(args?.relative);
      if (missing.includes(relative)) return Promise.reject(new Error(`asset file not found: ${relative}`));
      return [1, 2, 3];
    }
    return undefined;
  });
}

const callsFor = (cmd: string): Record<string, unknown>[] =>
  invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);

describe("exportPage（HTML 格式）", () => {
  beforeEach(() => {
    saveMock.mockReset();
    openMock.mockReset();
    writeMock.mockReset();
    docGetMock.mockReset();
    invokeMock.mockReset();
    saveMock.mockResolvedValue("D:/out/test.html");
    openMock.mockResolvedValue("D:/out");
    writeMock.mockResolvedValue(undefined);
    mockAssetCommands();
  });

  it("导出高级块（math/mermaid/附件/数据库视图/折叠/分栏/画廊）", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(RICH_DOC));
    await exportPage("v1", "测试页", "html");

    expect(writeMock).toHaveBeenCalledTimes(1);
    const html = writeMock.mock.calls[0]?.[1] as string;
    expect(html).toContain('<div class="math">E=mc^2</div>');
    expect(html).toContain('<pre class="mermaid">graph LR\n  A--&gt;B</pre>');
    expect(html).toContain('<p class="attachment"><a href="assets/报告.pdf">报告.pdf</a></p>');
    expect(html).toContain('<div class="database-view">任务表</div>');
    expect(html).toContain("<details open><summary>折叠标题</summary>");
    expect(html).toContain('<aside class="callout"><span class="callout-emoji">⚠️</span>');
    expect(html).toContain('<div class="columns"><div class="column">');
    expect(html).toContain('<div class="gallery"><img src="assets/a.png" alt="图一"/>');
    expect(html).not.toContain("outline");
  });

  it("转义正文 HTML，不产生可执行标签", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(RICH_DOC));
    await exportPage("v1", "测试页", "html");

    const html = writeMock.mock.calls[0]?.[1] as string;
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("取消目录选择时不写文件", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(RICH_DOC));
    openMock.mockResolvedValue(null);
    await exportPage("v1", "测试页", "html");
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe("exportPage（Markdown 格式）", () => {
  beforeEach(() => {
    saveMock.mockReset();
    openMock.mockReset();
    writeMock.mockReset();
    docGetMock.mockReset();
    invokeMock.mockReset();
    saveMock.mockResolvedValue("D:/out/test.md");
    openMock.mockResolvedValue("D:/out");
    writeMock.mockResolvedValue(undefined);
    mockAssetCommands();
  });

  it("高级块导出为可读 markdown / 占位注释", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(RICH_DOC));
    await exportPage("v1", "测试页", "markdown");

    const md = writeMock.mock.calls[0]?.[1] as string;
    expect(md).toContain("$$\nE=mc^2\n$$");
    expect(md).toContain("```mermaid\ngraph LR\n  A-->B\n```");
    expect(md).toContain("[报告.pdf](attach:assets/报告.pdf)");
    expect(md).toContain("→[任务表](db:db-1)");
    expect(md).toContain("<details open>\n<summary>折叠标题</summary>");
    expect(md).toContain("<!-- columns (2) -->");
    expect(md).toContain("<!-- /columns -->");
    expect(md).toContain("<!-- outline block -->");
  });
});

describe("exportPage（附件随导出落盘）", () => {
  const DOC_WITH_ASSETS = {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "assets/a.png", alt: "图一" } },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "同一张图再引一次：" },
          { type: "image", attrs: { src: "assets/a.png", alt: "图一再" } },
        ],
      },
      { type: "imageGallery", content: [{ type: "image", attrs: { src: "assets/b.jpg", alt: "图二" } }] },
      { type: "attachment", attrs: { src: "assets/报告.pdf", name: "报告.pdf" } },
      { type: "image", attrs: { src: "https://cdn.example.com/x.png", alt: "远程图" } },
      { type: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "内联图" } },
    ],
  };

  const PLAIN_DOC = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "纯文本页" }] }],
  };

  beforeEach(() => {
    saveMock.mockReset();
    openMock.mockReset();
    writeMock.mockReset();
    docGetMock.mockReset();
    invokeMock.mockReset();
    saveMock.mockResolvedValue("D:/out/plain.md");
    openMock.mockResolvedValue("D:/导出目录");
    writeMock.mockResolvedValue(undefined);
    mockAssetCommands();
  });

  it("复制到 <导出目录>/assets/ 并保持文档里的相对链接可点开", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(DOC_WITH_ASSETS));
    await exportPage("v1", "我的 页面", "markdown");

    expect(writeMock).toHaveBeenCalledWith(
      "D:/导出目录/我的 页面.md",
      expect.stringContaining("![图一](assets/a.png)"),
    );
    expect(callsFor("mkdir_all")).toEqual([{ path: "D:/导出目录/assets" }]);
    const writes = callsFor("write_binary_file");
    expect(writes.map((w) => w.path)).toEqual([
      "D:/导出目录/assets/a.png",
      "D:/导出目录/assets/b.jpg",
      "D:/导出目录/assets/报告.pdf",
    ]);
    expect(writes[0]?.bytes).toEqual([1, 2, 3]);
  });

  it("目录选择取消时不写文件也不复制", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(DOC_WITH_ASSETS));
    openMock.mockResolvedValue(null);
    await exportPage("v1", "页面", "html");
    expect(writeMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("磁盘上的附件文件缺失时跳过该文件，其余照常导出", async () => {
    mockAssetCommands(["assets/b.jpg"]);
    docGetMock.mockResolvedValue(JSON.stringify(DOC_WITH_ASSETS));
    await exportPage("v1", "页面", "markdown");

    expect(writeMock).toHaveBeenCalledTimes(1);
    const writes = callsFor("write_binary_file");
    expect(writes.map((w) => w.path)).toEqual(["D:/导出目录/assets/a.png", "D:/导出目录/assets/报告.pdf"]);
  });

  it("写入附件失败（如目标目录不可写）时导出仍然完成", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_asset_bytes") return [1];
      if (cmd === "write_binary_file") return Promise.reject(new Error("failed to write"));
      return undefined;
    });
    docGetMock.mockResolvedValue(JSON.stringify(DOC_WITH_ASSETS));
    await expect(exportPage("v1", "页面", "markdown")).resolves.toBeUndefined();
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("无附件的文档保持单文件保存对话框流程", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(PLAIN_DOC));
    await exportPage("v1", "纯文本页", "markdown");

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(openMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledWith("D:/out/plain.md", "纯文本页\n");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
