import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import { expandContainerToTextBlocks } from "./block-convert";

// banner ≈ callout/toggle/blockquote/columns（block+ 容器），
// statWidget ≈ block image/databaseView（无正文的 atom 块）
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    text: { group: "inline" },
    hardBreak: { inline: true, group: "inline" },
    image: { inline: true, group: "inline", attrs: { src: { default: "" } } },
    banner: { group: "block", content: "block+" },
    bulletList: { group: "block", content: "listItem+" },
    listItem: { content: "block+" },
    statWidget: { group: "block" },
  },
  marks: { bold: {}, italic: {} },
});

const node = (json: JSONContent) => PMNode.fromJSON(schema, json);

describe("expandContainerToTextBlocks", () => {
  it("文本块整体保留：行内 marks、硬换行、原子 inline 节点不丢失", () => {
    const banner = node({
      type: "banner",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "he", marks: [{ type: "bold" }] },
            { type: "text", text: "llo" },
            { type: "hardBreak" },
            { type: "image", attrs: { src: "a.png" } },
          ],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
      ],
    });
    expect(expandContainerToTextBlocks(banner)).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "he", marks: [{ type: "bold" }] },
          { type: "text", text: "llo" },
          { type: "hardBreak" },
          { type: "image", attrs: { src: "a.png" } },
        ],
      },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
    ]);
  });

  it("嵌套容器与列表外壳递归展开、丢弃", () => {
    const banner = node({
      type: "banner",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "甲" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "banner",
          content: [{ type: "paragraph", content: [{ type: "text", text: "内层" }] }],
        },
      ],
    });
    expect(expandContainerToTextBlocks(banner)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "甲" }] },
      { type: "paragraph", content: [{ type: "text", text: "乙" }] },
      { type: "paragraph", content: [{ type: "text", text: "内层" }] },
    ]);
  });

  it("无正文的 atom 块跳过；只剩 atom 时补一个空段落", () => {
    const banner = node({
      type: "banner",
      content: [
        { type: "statWidget" },
        { type: "paragraph", content: [{ type: "text", text: "留" }] },
        { type: "statWidget" },
      ],
    });
    expect(expandContainerToTextBlocks(banner)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "留" }] },
    ]);
    const onlyAtom = node({ type: "banner", content: [{ type: "statWidget" }] });
    expect(expandContainerToTextBlocks(onlyAtom)).toEqual([{ type: "paragraph" }]);
  });

  it("展开结果可直接重建为合法文档", () => {
    const banner = node({
      type: "banner",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "italic" }] }] }],
    });
    const blocks = expandContainerToTextBlocks(banner);
    const rebuilt = PMNode.fromJSON(schema, { type: "doc", content: blocks });
    expect(rebuilt.childCount).toBe(1);
    expect(rebuilt.firstChild?.firstChild?.marks.map((m) => m.type.name)).toEqual(["italic"]);
  });
});
