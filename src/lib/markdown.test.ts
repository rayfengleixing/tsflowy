import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, markdownToJson, parseInline, textToBlocks } from "./markdown";

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
    expect(looksLikeMarkdown("普通文本第一行\n第二行")).toBe(false);
  });

  it("splits plain text lines into paragraphs preserving newlines", () => {
    const json = textToBlocks("print(\"hello\")\nprint(\"你好\")");
    expect(json.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: 'print("hello")' }] },
      { type: "paragraph", content: [{ type: "text", text: 'print("你好")' }] },
    ]);
  });
});