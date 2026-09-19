import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, markdownToJson, parseInline, textToBlocks, jsonToMarkdown } from "./markdown";

describe("parseInline", () => {
  it("parses bold, italic, strike, code, link and image", () => {
    const out = parseInline("a **粗** b *斜* c `码` d ~~删~~ e [链接](https://x.com) f ![图](assets/a.png)");
    expect(out).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: "粗", marks: [{ type: "bold" }] },
      { type: "text", text: " b " },
      { type: "text", text: "斜", marks: [{ type: "italic" }] },
      { type: "text", text: " c " },
      { type: "text", text: "码", marks: [{ type: "code" }] },
      { type: "text", text: " d " },
      { type: "text", text: "删", marks: [{ type: "strike" }] },
      { type: "text", text: " e " },
      { type: "text", text: "链接", marks: [{ type: "link", attrs: { href: "https://x.com" } }] },
      { type: "text", text: " f " },
      { type: "image", attrs: { src: "assets/a.png", alt: "图" } },
    ]);
  });

  it("keeps plain text untouched", () => {
    expect(parseInline("普通文本")).toEqual([{ type: "text", text: "普通文本" }]);
  });
});

describe("markdownToJson", () => {
  it("converts headings", () => {
    const json = markdownToJson("# 一级\n## 二级\n### 三级");
    expect(json.content?.map((b) => [b.type, b.attrs])).toEqual([
      ["heading", { level: 1 }],
      ["heading", { level: 2 }],
      ["heading", { level: 3 }],
    ]);
  });

  it("converts bullet and ordered lists", () => {
    const json = markdownToJson("- 苹果\n- 香蕉\n\n1. 第一\n2. 第二");
    expect(json.content).toEqual([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "苹果" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "香蕉" }] }] },
        ],
      },
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第一" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第二" }] }] },
        ],
      },
    ]);
  });

  it("converts task list with checked state", () => {
    const json = markdownToJson("- [ ] 未完成\n- [x] 已完成");
    expect(json.content?.[0]).toEqual({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "未完成" }] }],
        },
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "已完成" }] }],
        },
      ],
    });
  });

  it("converts code fence with language", () => {
    const json = markdownToJson("```ts\nconst a = 1;\n```");
    expect(json.content?.[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
  });

  it("converts $$ display math fence", () => {
    const json = markdownToJson("$$\nE=mc^2\n$$");
    expect(json.content?.[0]).toEqual({ type: "math", attrs: { tex: "E=mc^2" } });
  });

  it("converts single-line $$...$$ math", () => {
    const json = markdownToJson("$$E=mc^2$$");
    expect(json.content?.[0]).toEqual({ type: "math", attrs: { tex: "E=mc^2" } });
  });

  it("converts ```mermaid fence into mermaid node (not codeBlock)", () => {
    const json = markdownToJson("```mermaid\ngraph TD\n  A --> B\n```");
    expect(json.content?.[0]).toEqual({ type: "mermaid", attrs: { code: "graph TD\n  A --> B" } });
  });

  it("keeps plain code fence as codeBlock when lang is not mermaid", () => {
    const json = markdownToJson("```js\nconsole.log(1)\n```");
    expect(json.content?.[0]?.type).toBe("codeBlock");
  });

  it("mermaid fence round-trips", () => {
    const src = "```mermaid\ngraph LR\n  A -->|text| B\n```";
    const json = markdownToJson(src);
    const md = jsonToMarkdown(json);
    expect(md).toContain("```mermaid\ngraph LR\n  A -->|text| B\n```");
  });

  it("parses image width suffix and round-trips it", () => {
    const json = markdownToJson("![alt](assets/x.png{width=60%})");
    expect(json.content?.[0]?.content?.[0]?.attrs).toEqual({ src: "assets/x.png", alt: "alt", width: 60 });
    const md = jsonToMarkdown(json);
    expect(md).toContain("![alt](assets/x.png{width=60%})");
  });

  it("exports table cells containing image blocks as inline markdown", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "image", attrs: { src: "a.png", alt: "", width: 100 } }] },
              ],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("| ![](a.png) |");
  });

  it("consumes unterminated math fence to end of input", () => {
    const json = markdownToJson("$$\na+b");
    expect(json.content).toEqual([{ type: "math", attrs: { tex: "a+b" } }]);
  });

  it("converts <details open> with summary into expanded toggle", () => {
    const json = markdownToJson("<details open>\n<summary>折叠标题</summary>\n\n隐藏内容\n\n</details>");
    expect(json.content?.[0]).toEqual({
      type: "toggle",
      attrs: { collapsed: false },
      content: [
        { type: "paragraph", content: [{ type: "text", text: "折叠标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "隐藏内容" }] },
      ],
    });
  });

  it("converts <details> without open into collapsed toggle", () => {
    const json = markdownToJson("<details>\n<summary>标题</summary>\n\n内容\n\n</details>");
    expect(json.content?.[0]?.type).toBe("toggle");
    expect(json.content?.[0]?.attrs).toEqual({ collapsed: true });
  });

  it("decodes HTML entities in summary title", () => {
    const json = markdownToJson("<details open>\n<summary>a &amp; b &lt;c&gt;</summary>\n\n正文\n\n</details>");
    expect(json.content?.[0]?.content?.[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "a & b <c>" }],
    });
  });

  it("handles nested details via depth counting", () => {
    const md = [
      "<details open>",
      "<summary>外层</summary>",
      "",
      "<details>",
      "<summary>内层</summary>",
      "",
      "深处",
      "",
      "</details>",
      "",
      "</details>",
    ].join("\n");
    const outer = markdownToJson(md).content?.[0];
    expect(outer?.type).toBe("toggle");
    expect(outer?.attrs).toEqual({ collapsed: false });
    // 内层 toggle 是外层的第二个子块
    const nested = outer?.content?.find((c) => c.type === "toggle");
    expect(nested?.attrs).toEqual({ collapsed: true });
    expect(nested?.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "内层" }] },
      { type: "paragraph", content: [{ type: "text", text: "深处" }] },
    ]);
    // 深度计数应恰好吃掉外层闭合标签，不残留 </details> 段落
    expect(markdownToJson(md).content).toHaveLength(1);
  });

  it("converts blockquote and horizontal rule", () => {
    const json = markdownToJson("> 引用一句\n\n---");
    expect(json.content).toEqual([
      { type: "blockquote", content: [{ type: "text", text: "引用一句" }] },
      { type: "horizontalRule" },
    ]);
  });

  it("joins consecutive non-empty lines into one paragraph", () => {
    const json = markdownToJson("第一行\n第二行");
    expect(json.content?.[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "第一行 第二行" }],
    });
  });

  it("returns empty doc for empty input", () => {
    expect(markdownToJson("")).toEqual({ type: "doc", content: [] });
    expect(markdownToJson("\n\n")).toEqual({ type: "doc", content: [] });
  });
});

describe("looksLikeMarkdown / textToBlocks", () => {
  it("detects markdown structures", () => {
    expect(looksLikeMarkdown("# 标题")).toBe(true);
    expect(looksLikeMarkdown("- 列表项")).toBe(true);
    expect(looksLikeMarkdown("> 引用")).toBe(true);
    expect(looksLikeMarkdown("```js\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("---")).toBe(true);
    expect(looksLikeMarkdown("$$\nE=mc^2\n$$")).toBe(true);
    expect(looksLikeMarkdown("<details>\n<summary>x</summary>\n</details>")).toBe(true);
    expect(looksLikeMarkdown("普通文本第一行\n第二行")).toBe(false);
  });

  it("splits plain text lines into paragraphs preserving newlines", () => {
    const json = textToBlocks('print("hello")\nprint("你好")');
    expect(json.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: 'print("hello")' }] },
      { type: "paragraph", content: [{ type: "text", text: 'print("你好")' }] },
    ]);
  });
});

describe("jsonToMarkdown", () => {
  it("renders headings with correct # levels", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题一" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题二" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "标题三" }] },
      ],
    });
    expect(md).toMatch(/^# 标题一$/m);
    expect(md).toMatch(/^## 标题二$/m);
    expect(md).toMatch(/^### 标题三$/m);
  });

  it("renders inline marks: bold/italic/strike/code/link/highlight", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "字", marks: [{ type: "bold" }] },
            { type: "text", text: " " },
            { type: "text", text: "斜", marks: [{ type: "italic" }] },
            { type: "text", text: " " },
            { type: "text", text: "删", marks: [{ type: "strike" }] },
            { type: "text", text: " " },
            { type: "text", text: "码", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            { type: "text", text: "链", marks: [{ type: "link", attrs: { href: "https://x" } }] },
            { type: "text", text: " " },
            { type: "text", text: "亮", marks: [{ type: "highlight" }] },
          ],
        },
      ],
    });
    expect(md).toContain("**字**");
    expect(md).toContain("*斜*");
    expect(md).toContain("~~删~~");
    expect(md).toContain("`码`");
    expect(md).toContain("[链](https://x)");
    expect(md).toContain("==亮==");
  });

  it("renders bullet, ordered, and task lists", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "苹果" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "香蕉" }] }] },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "一" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "二" }] }] },
          ],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "未" }] }],
            },
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "已" }] }],
            },
          ],
        },
      ],
    });
    expect(md).toMatch(/^- 苹果$/m);
    expect(md).toMatch(/^- 香蕉$/m);
    expect(md).toMatch(/^1\. 一$/m);
    expect(md).toMatch(/^2\. 二$/m);
    expect(md).toMatch(/^- \[ \] 未$/m);
    expect(md).toMatch(/^- \[x\] 已$/m);
  });

  it("renders code block with language fence", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
        },
      ],
    });
    expect(md).toContain("```ts\nconst a = 1;\nconst b = 2;\n```");
  });

  it("renders code block without language as plain fence", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: null },
          content: [{ type: "text", text: "code line" }],
        },
      ],
    });
    expect(md).toContain("```\ncode line\n```");
  });

  it("renders image and mention nodes", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "a.png", alt: "图" } },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "mention", attrs: { id: "v123", label: "目标页" } },
          ],
        },
      ],
    });
    expect(md).toContain("![图](a.png)");
    expect(md).toContain("@[目标页](view:v123)");
  });

  it("renders horizontal rule, blockquote, and table", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        { type: "horizontalRule" },
        { type: "blockquote", content: [{ type: "text", text: "引言" }] },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "text", text: "A" }] },
                { type: "tableHeader", content: [{ type: "text", text: "B" }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "text", text: "1" }] },
                { type: "tableCell", content: [{ type: "text", text: "2" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(md).toContain("---");
    expect(md).toMatch(/^> 引言$/m);
    expect(md).toMatch(/^\| A \| B \|$/m);
    expect(md).toMatch(/^\| --- \| --- \|$/m);
    expect(md).toMatch(/^\| 1 \| 2 \|$/m);
  });

  it("renders math block with real tex attribute", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [{ type: "math", attrs: { tex: "E=mc^2" } }],
    });
    expect(md).toContain("$$\nE=mc^2\n$$");
  });

  it("renders math block without attrs without crashing", () => {
    const md = jsonToMarkdown({ type: "doc", content: [{ type: "math" }] });
    expect(md).toContain("$$");
  });

  it("renders toggle block with first paragraph lifted into summary", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { collapsed: false },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "折叠标题" }] },
            { type: "paragraph", content: [{ type: "text", text: "隐藏内容" }] },
          ],
        },
      ],
    });
    expect(md).toContain("<details open>");
    expect(md).toContain("<summary>折叠标题</summary>");
    expect(md).toContain("隐藏内容");
    // 标题只应出现在 summary，不重复出现在正文
    expect(md.match(/折叠标题/g)).toHaveLength(1);
  });

  it("exports collapsed toggle as closed details", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { collapsed: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "标题" }] }],
        },
      ],
    });
    expect(md).toContain("<details>\n<summary>标题</summary>");
    expect(md).not.toContain("<details open>");
  });

  it("renders empty toggle without crashing", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [{ type: "toggle", attrs: { collapsed: false }, content: [{ type: "paragraph" }] }],
    });
    expect(md).toContain("<details open>");
    expect(md).toContain("</details>");
  });

  it("outputs placeholder comments for advanced blocks without crashing", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [{ type: "database-view", attrs: { viewId: "db-1" } }, { type: "outline" }],
    });
    expect(md).toContain("<!-- database view: db-1 -->");
    expect(md).toContain("<!-- outline block -->");
  });

  it("round-trips basic markdown through markdownToJson → jsonToMarkdown", () => {
    const input = "# 欢迎\n\n- 苹果\n- 香蕉\n\n> 引用一段\n\n```\ncode line\n```\n";
    const json = markdownToJson(input);
    const output = jsonToMarkdown(json);
    expect(output).toMatch(/^# 欢迎$/m);
    expect(output).toMatch(/^- 苹果$/m);
    expect(output).toMatch(/^- 香蕉$/m);
    expect(output).toMatch(/^> 引用一段$/m);
    expect(output).toMatch(/^```$/m);
    expect(output).toMatch(/^code line$/m);
  });

  it("round-trips math: json → md → json", () => {
    const json = { type: "doc", content: [{ type: "math", attrs: { tex: "E=mc^2" } }] };
    const md = jsonToMarkdown(json);
    expect(md).toContain("$$\nE=mc^2\n$$");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips collapsed toggle: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { collapsed: true },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "折叠标题" }] },
            { type: "paragraph", content: [{ type: "text", text: "隐藏内容" }] },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("<details>\n<summary>折叠标题</summary>");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips expanded toggle: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { collapsed: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "展开标题" }] }],
        },
      ],
    };
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });
});
