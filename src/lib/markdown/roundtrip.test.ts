import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";
import { markdownToJson, jsonToMarkdown } from ".";

describe("jsonToMarkdown", () => {
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

  it("round-trips nested lists: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
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
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "子" }] },
                        {
                          type: "taskList",
                          content: [
                            {
                              type: "taskItem",
                              attrs: { checked: true },
                              content: [{ type: "paragraph", content: [{ type: "text", text: "任务" }] }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("  - 子");
    expect(md).toContain("    - [x] 任务");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips table cells containing the pipe character", () => {
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
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "x | y" }] }],
                },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
              ],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("x \\| y");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips callout: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { emoji: "💡", color: "blue" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "提示正文" }] }],
        },
      ],
    };
    // 蓝是默认色，导出保持旧格式（不写注释），历史 md 文件回读才不会被判定成格式变化
    expect(jsonToMarkdown(json).trim()).toBe("> 💡 **Callout**\n> 提示正文");
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });

  it("round-trips a non-default callout color through the marker", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { emoji: "🔥", color: "green" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "提示正文" }] }],
        },
      ],
    };
    expect(jsonToMarkdown(json).trim()).toBe("> 🔥 **Callout** <!-- color:green -->\n> 提示正文");
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });

  it("writes block alignment into a trailing marker and reads it back", () => {
    const json = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1, textAlign: "center" }, content: [{ type: "text", text: "标题" }] },
        { type: "paragraph", attrs: { textAlign: "justify" }, content: [{ type: "text", text: "正文" }] },
      ],
    };
    expect(jsonToMarkdown(json).trim()).toBe("# 标题 <!-- align:center -->\n\n正文 <!-- align:justify -->");
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });

  it("leaves default and left alignment out of the exported markdown", () => {
    const json = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "无属性" }] },
        { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "显式左对齐" }] },
      ],
    };
    expect(jsonToMarkdown(json).trim()).toBe("无属性\n\n显式左对齐");
    // 回读只还原正文，不再补 attrs：left 与默认同义，避免多出一个属性让 toEqual 失败
    expect(markdownToJson(jsonToMarkdown(json))).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "无属性" }] },
        { type: "paragraph", content: [{ type: "text", text: "显式左对齐" }] },
      ],
    });
  });

  it("round-trips gallery: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "imageGallery",
          content: [
            { type: "image", attrs: { src: "a.png", alt: "图A" } },
            { type: "image", attrs: { src: "b.png", alt: "", width: 60 } },
          ],
        },
      ],
    };
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });

  it("round-trips outline: json → md → json", () => {
    const json = { type: "doc", content: [{ type: "outline" }] };
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });

  it("round-trips underline mark: json → md → json", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "前 " },
            { type: "text", text: "划线", marks: [{ type: "underline" }] },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("<u>划线</u>");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips colored highlight while plain highlight stays ==", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "默认", marks: [{ type: "highlight" }] },
            { type: "text", text: "带色", marks: [{ type: "highlight", attrs: { color: "#FEF3C7" } }] },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain("==默认==");
    expect(md).toContain('<mark data-color="#FEF3C7"');
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips text color through <span style>", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "蓝字", marks: [{ type: "textStyle", attrs: { color: "#0092D6" } }] }],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toContain('<span style="color: #0092D6">蓝字</span>');
    expect(markdownToJson(md)).toEqual(json);
  });

  it("round-trips color stacked on bold + underline", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "重点",
              marks: [{ type: "bold" }, { type: "underline" }, { type: "textStyle", attrs: { color: "#D92D20" } }],
            },
          ],
        },
      ],
    };
    expect(markdownToJson(jsonToMarkdown(json))).toEqual(json);
  });

  it("treats the inherit text color as no color", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "默认色", marks: [{ type: "textStyle", attrs: { color: "inherit" } }] }],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).not.toContain("<span");
    expect(md).toContain("默认色");
  });

  it("round-trips image caption through the markdown title slot", () => {
    const json = markdownToJson('![图](assets/a.png "说明文字"{width=60%})');
    expect(json.content?.[0]?.content?.[0]?.attrs).toEqual({
      src: "assets/a.png",
      alt: "图",
      caption: "说明文字",
      width: 60,
    });
    expect(jsonToMarkdown(json)).toContain('![图](assets/a.png "说明文字"{width=60%})');
  });

  it("keeps captions without a title slot unchanged and sanitizes breaking characters", () => {
    const json = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "a.png", alt: "", caption: '含"引号"和(括号)' } }],
    };
    const md = jsonToMarkdown(json);
    // 半角括号会截断 ![...](...)，导出换成全角；引号折成单引号，回读仍是同一张图片
    const parsed = markdownToJson(md);
    expect(parsed.content?.[0]?.content?.[0]?.type).toBe("image");
    expect(parsed.content?.[0]?.content?.[0]?.attrs).toEqual({ src: "a.png", alt: "", caption: "含'引号'和（括号）" });
  });
});

describe("hardBreak 往返", () => {
  it("段内手动换行导出为行尾两空格，读回还是 hardBreak", () => {
    const json: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "第一行" }, { type: "hardBreak" }, { type: "text", text: "第二行" }],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md).toBe("第一行  \n第二行\n");
    expect(markdownToJson(md)).toEqual(json);
  });

  it("相邻普通行仍算软换行，不会被误判成硬换行", () => {
    const json = markdownToJson("甲\n乙");
    expect(json.content?.[0]?.content).toEqual([{ type: "text", text: "甲 乙" }]);
  });

  it("表格单元格内的换行写成 <br>，不会把表格拆断", () => {
    const json: JSONContent = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "列" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "甲" }, { type: "hardBreak" }] },
                    { type: "text", text: "乙" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = jsonToMarkdown(json);
    expect(md.replace(/\n$/, "").split("\n")).toHaveLength(3); // 多一行就是导出了坏表格
    expect(md).toContain("| 甲<br>乙 |");
    const back = markdownToJson(md);
    const cell = back.content?.[0]?.content?.[1]?.content?.[0];
    expect(JSON.stringify(cell?.content)).toContain("hardBreak");
  });
});

describe("databaseView 附表快照", () => {
  it("指针后的表格被注释圈住，导回只剩指针不另成表格块", () => {
    const json = {
      type: "doc",
      content: [{ type: "databaseView", attrs: { viewId: "db-1", name: "任务表" } }],
    };
    const md = jsonToMarkdown(json, { databaseTables: { "db-1": "| 标题 |\n| --- |\n| 写文档 |" } });
    expect(md).toContain("<!-- db-table begin -->");
    expect(md).toContain("<!-- db-table end -->");
    expect(markdownToJson(md)).toEqual(json);
    // 关掉快照（老导出格式）时表格照旧读回，别让跳过逻辑吃掉用户手打的表格
    expect(markdownToJson("→[任务表](db:db-1)\n\n| 标题 |\n| --- |\n| 写文档 |").content?.map((b) => b.type)).toEqual([
      "databaseView",
      "table",
    ]);
  });
});

describe("toggle 与单元格的细节保真", () => {
  it("标题型 toggle 的级别跟进 summary 属性，读回仍是同级标题", () => {
    for (const level of [2, 3, 4]) {
      const json = {
        type: "doc",
        content: [
          {
            type: "toggle",
            attrs: { collapsed: false },
            content: [
              { type: "heading", attrs: { level }, content: [{ type: "text", text: "小节" }] },
              { type: "paragraph", content: [{ type: "text", text: "正文" }] },
            ],
          },
        ],
      };
      const md = jsonToMarkdown(json);
      expect(md).toContain(`<summary data-level="${level}">小节</summary>`);
      const title = markdownToJson(md).content?.[0]?.content?.[0];
      expect(title?.type).toBe("heading");
      expect(title?.attrs).toEqual({ level });
    }
  });

  it("段落型 toggle 不写 data-level，读回还是段落", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { collapsed: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "标题段" }] }],
        },
      ],
    };
    expect(jsonToMarkdown(json)).toContain("<summary>标题段</summary>");
    expect(markdownToJson(jsonToMarkdown(json)).content?.[0]?.content?.[0]?.type).toBe("paragraph");
  });

  it("单元格里的对齐不进正文：既不写注释残迹，也读掉老导出留下的标记", () => {
    const json = {
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
                  content: [
                    {
                      type: "paragraph",
                      attrs: { textAlign: "center" },
                      content: [{ type: "text", text: "居中" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(jsonToMarkdown(json)).not.toContain("align:center");
    expect(markdownToJson("| 居中 <!-- align:center --> |\n| --- |").content?.[0]).toBeTruthy();
    expect(jsonToMarkdown(markdownToJson("| 居中 <!-- align:center --> |\n| --- |"))).toContain("居中");
    expect(jsonToMarkdown(markdownToJson("| 居中 <!-- align:center --> |\n| --- |"))).not.toContain("align:center");
  });
});
