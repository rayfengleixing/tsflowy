import { beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());
const docGetMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: writeMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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

describe("exportPage（HTML 格式）", () => {
  beforeEach(() => {
    saveMock.mockReset();
    writeMock.mockReset();
    docGetMock.mockReset();
    saveMock.mockResolvedValue("D:/out/test.html");
    writeMock.mockResolvedValue(undefined);
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

  it("取消保存对话框时不写文件", async () => {
    docGetMock.mockResolvedValue(JSON.stringify(RICH_DOC));
    saveMock.mockResolvedValue(null);
    await exportPage("v1", "测试页", "html");
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe("exportPage（Markdown 格式）", () => {
  beforeEach(() => {
    saveMock.mockReset();
    writeMock.mockReset();
    docGetMock.mockReset();
    saveMock.mockResolvedValue("D:/out/test.md");
    writeMock.mockResolvedValue(undefined);
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
