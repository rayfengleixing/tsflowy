import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, markdownToJson, parseInline, textToBlocks, jsonToMarkdown } from ".";

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

  it("parses <u>…</u> into underline marks, inner marks preserved", () => {
    expect(parseInline("<u>划线</u>")).toEqual([{ type: "text", text: "划线", marks: [{ type: "underline" }] }]);
    expect(parseInline("<u>**粗**划线</u>")).toEqual([
      { type: "text", text: "粗", marks: [{ type: "bold" }, { type: "underline" }] },
      { type: "text", text: "划线", marks: [{ type: "underline" }] },
    ]);
  });
});

describe("markdownToJson", () => {
  it("converts headings", () => {
    const json = markdownToJson("# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级");
    expect(json.content?.map((b) => [b.type, b.attrs])).toEqual([
      ["heading", { level: 1 }],
      ["heading", { level: 2 }],
      ["heading", { level: 3 }],
      ["heading", { level: 4 }],
      ["heading", { level: 5 }],
      ["heading", { level: 6 }],
    ]);
  });

  it("七个井号按 Markdown 口径不是标题，别被截成六级", () => {
    expect(markdownToJson("####### 七").content?.map((b) => b.type)).toEqual(["paragraph"]);
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

  it("读回任务行尾的 due / assignee 标记", () => {
    const json = markdownToJson("- [ ] 写周报 <!-- task due=2026-10-20 assignee=张三 -->\n- [x] 老任务");
    const items = json.content?.[0].content ?? [];
    expect(items[0].attrs).toEqual({ checked: false, due: "2026-10-20", assignee: "张三" });
    expect(items[0].content?.[0].content).toEqual([{ type: "text", text: "写周报" }]);
    // 无元数据的历史行不补空 attrs，JSON 形状与旧导出一致
    expect(items[1].attrs).toEqual({ checked: true });
  });

  it("坏 due 与空 assignee 不进 attrs，标记照样从正文里摘干净", () => {
    const json = markdownToJson("- [ ] 甲 <!-- task due=2026-02-30 assignee=  -->");
    const item = json.content?.[0].content?.[0];
    expect(item?.attrs).toEqual({ checked: false });
    expect(item?.content?.[0].content).toEqual([{ type: "text", text: "甲" }]);
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
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "引用一句" }] }] },
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

  it("builds nested lists from indentation instead of flattening", () => {
    const json = markdownToJson("- 父\n  - 子\n- 次");
    expect(json.content).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "父" }] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "子" }] }] },
                ],
              },
            ],
          },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "次" }] }] },
        ],
      },
    ]);
  });

  it("splits table rows on unescaped pipes only", () => {
    const json = markdownToJson("| A \\| B | C |\n| --- | --- |\n| 1 | 2 |");
    const header = json.content?.[0]?.content?.[0];
    expect(header?.content?.[0]?.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "A | B" }] }]);
    expect(header?.content?.[1]?.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "C" }] }]);
  });

  it("restores callout export format as callout node", () => {
    const json = markdownToJson("> ⚠️ **Callout**\n> 注意内容");
    expect(json.content).toEqual([
      {
        type: "callout",
        attrs: { emoji: "⚠️", color: "blue" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "注意内容" }] }],
      },
    ]);
  });

  it("reads the callout color marker written by the exporter", () => {
    const json = markdownToJson("> 🔥 **Callout** <!-- color:orange -->\n> 注意内容");
    expect(json.content?.[0]?.attrs).toEqual({ emoji: "🔥", color: "orange" });
  });

  it("falls back to blue for a callout color marker with an unknown color", () => {
    expect(markdownToJson("> **Callout** <!-- color:rainbow -->\n> 内容").content?.[0]?.attrs).toEqual({
      emoji: "💡",
      color: "blue",
    });
  });

  it("strips the align marker from paragraph and heading lines", () => {
    const json = markdownToJson("## 居中标题 <!-- align:center -->\n\n右对齐正文 <!-- align:right -->");
    expect(json.content).toEqual([
      { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "居中标题" }] },
      { type: "paragraph", attrs: { textAlign: "right" }, content: [{ type: "text", text: "右对齐正文" }] },
    ]);
  });

  it("ignores an align marker sitting anywhere but the end of the line", () => {
    const json = markdownToJson("普通段落里提到 <!-- align:center --> 这种字样");
    expect(json.content?.[0]?.attrs).toBeUndefined();
    expect(json.content?.[0]?.content?.[0]?.text).toContain("align");
  });

  it("restores gallery export format as imageGallery node (no comment residue)", () => {
    const json = markdownToJson("<!-- image gallery (2 images) -->\n![a](a.png)\n![b](b.png)");
    expect(json.content).toEqual([
      {
        type: "imageGallery",
        content: [
          { type: "image", attrs: { src: "a.png", alt: "a" } },
          { type: "image", attrs: { src: "b.png", alt: "b" } },
        ],
      },
    ]);
  });

  it("restores outline placeholder comment as outline node", () => {
    expect(markdownToJson("<!-- outline block -->")).toEqual({ type: "doc", content: [{ type: "outline" }] });
  });
});

describe("looksLikeMarkdown / textToBlocks", () => {
  it("detects markdown structures", () => {
    expect(looksLikeMarkdown("# 标题")).toBe(true);
    expect(looksLikeMarkdown("#### 四级标题")).toBe(true);
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
