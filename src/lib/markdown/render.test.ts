import { describe, expect, it } from "vitest";
import { markdownToJson, jsonToMarkdown } from ".";

describe("jsonToMarkdown", () => {
  it("renders headings with correct # levels", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题一" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题二" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "标题三" }] },
        { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "标题四" }] },
        { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "标题五" }] },
        { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "标题六" }] },
      ],
    });
    expect(md).toMatch(/^# 标题一$/m);
    expect(md).toMatch(/^## 标题二$/m);
    expect(md).toMatch(/^### 标题三$/m);
    expect(md).toMatch(/^#### 标题四$/m);
    expect(md).toMatch(/^##### 标题五$/m);
    expect(md).toMatch(/^###### 标题六$/m);
    // 六级标题导出后必须原样读回来：任一边收窄都会让 #### 往返退化成段落
    expect(markdownToJson(md).content?.map((b) => Number(b.attrs?.level))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("越界级别夹回 1-6，不会打出七个井号", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 0 }, content: [{ type: "text", text: "零" }] },
        { type: "heading", attrs: { level: 9 }, content: [{ type: "text", text: "九" }] },
      ],
    });
    expect(md).toMatch(/^# 零$/m);
    expect(md).toMatch(/^#{6} 九$/m);
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

  it("任务行的截止日期与负责人写成行尾标记，且能被读回", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false, due: "2026-10-20", assignee: "张三" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "写周报" }] }],
            },
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "老任务" }] }],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(doc);
    expect(md).toContain("- [ ] 写周报 <!-- task due=2026-10-20 assignee=张三 -->");
    // 空元数据不写标记，历史导出格式零变化
    expect(md).toMatch(/^- \[x\] 老任务$/m);
    expect(md).not.toContain("<!-- task -->");
    expect(markdownToJson(md).content).toEqual(doc.content);
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

  it("round-trips databaseView and keeps outline as placeholder", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [{ type: "databaseView", attrs: { viewId: "db-1", name: "任务表" } }, { type: "outline" }],
    });
    expect(md).toContain("→[任务表](db:db-1)");
    expect(md).toContain("<!-- outline block -->");
    expect(markdownToJson("→[任务表](db:db-1)")).toEqual({
      type: "doc",
      content: [{ type: "databaseView", attrs: { viewId: "db-1", name: "任务表" } }],
    });
  });

  it("round-trips mention: json → md → json", () => {
    const json = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "v1", label: "目标页" } }] }],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("@[目标页](view:v1)");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips attachment with src/name: json → md → json", () => {
    const json = {
      type: "doc",
      content: [{ type: "attachment", attrs: { src: "assets/报告.pdf", name: "报告.pdf" } }],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("[报告.pdf](attach:assets/报告.pdf)");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("parses highlight and keeps it through a round trip", () => {
    const json = markdownToJson("前 ==重点== 后");
    expect(json.content?.[0]?.content).toEqual([
      { type: "text", text: "前 " },
      { type: "text", text: "重点", marks: [{ type: "highlight" }] },
      { type: "text", text: " 后" },
    ]);
    expect(jsonToMarkdown(json)).toContain("==重点==");
  });

  it("unescapes backslash text instead of re-parsing it as markup", () => {
    const json = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "*字面星号* 与 [方括号]" }] }],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("\\*字面星号\\*");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("escapes = | < $ so they survive the round trip as literal text", () => {
    const json = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a=b | c<d $$不是数学$$" }] }],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("\\=");
    expect(md).toContain("\\|");
    expect(md).toContain("\\<");
    expect(md).toContain("\\$");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips a table: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
              ],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("| A | B |");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("合并导出后导回：形状仍是一张表，合并按 GFM 语义丢弃", () => {
    const cell = (type: string, text: string, attrs?: Record<string, number>) => ({
      type,
      attrs,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const json = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("tableHeader", "A", { colspan: 2 }), cell("tableHeader", "C")] },
            { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2"), cell("tableCell", "3")] },
          ],
        },
      ],
    };
    const back = markdownToJson(jsonToMarkdown(json));
    const rows = (back.content?.[0].content ?? []).map((r) => (r.content ?? []).length);
    expect(rows).toEqual([3, 3]); // 补齐成矩形，读回来不会多一格少一格
    expect(back.content?.[0].content?.[0].content?.[2].content?.[0].content?.[0].text).toBe("C");
  });

  it("跨行合并：下一行本来就少一个节点，占位由上一行的 rowspan 补出", () => {
    const cell = (text: string, attrs?: Record<string, number>) => ({
      type: "tableCell",
      attrs,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("A", { rowspan: 2 }), cell("B")] },
            { type: "tableRow", content: [cell("C")] },
          ],
        },
      ],
    });
    expect(md.split("\n").filter((l) => l.startsWith("|"))).toEqual(["| A | B |", "| --- | --- |", "|  | C |"]);
  });

  it("坏数据（rowspan 超出真实行数）只补空行，不抛异常", () => {
    const md = jsonToMarkdown({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { rowspan: 5 },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    // 表头 + 分隔行 + 被撑出来的 4 行
    expect(md.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(6);
  });

  it("round-trips columns: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "columns",
          content: [
            {
              type: "column",
              attrs: { ratio: 1 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "左栏" }] }],
            },
            {
              type: "column",
              attrs: { ratio: 1 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "右栏" }] }],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("<!-- columns (2) -->");
    expect(md).toContain("<!-- column 2/2 -->");
    expect(md).toContain("<!-- /columns -->");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips column ratios（列宽拖过就写第三段，均分保持老格式）", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "columns",
          content: [
            { type: "column", attrs: { ratio: 2 }, content: [{ type: "paragraph" }] },
            { type: "column", attrs: { ratio: 0.5 }, content: [{ type: "paragraph" }] },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("<!-- column 1/2 2 -->");
    expect(md).toContain("<!-- column 2/2 0.5 -->");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("无比例段的旧分栏标记仍按均分导入", () => {
    const md = [
      "<!-- columns (2) -->",
      "<!-- column 1/2 -->",
      "左",
      "<!-- column 2/2 -->",
      "右",
      "<!-- /columns -->",
    ].join("\n");
    const columnRatios = (markdownToJson(md).content?.[0].content ?? []).map((col) => Number(col.attrs?.ratio));
    expect(columnRatios).toEqual([1, 1]);
  });

  it("坏的分栏比例值退回均分而不是把列搞没", () => {
    const md = ["<!-- columns (1) -->", "<!-- column 1/1 abc -->", "只有一列", "<!-- /columns -->"].join("\n");
    expect(markdownToJson(md).content?.[0].content?.[0].attrs?.ratio).toBe(1);
  });
});
