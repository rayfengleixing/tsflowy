import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import { collectMatches } from "./find-replace";

// 位置映射是这块逻辑唯一容易出错的地方：跨 mark、原子 inline 节点、多块文档
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    text: { group: "inline" },
    hardBreak: { inline: true, group: "inline" },
  },
  marks: { bold: {}, italic: {} },
});

const doc = (content: unknown) => PMNode.fromJSON(schema, { type: "doc", content });
const text = (value: string, marks?: { type: string }[]) => ({ type: "text", text: value, marks });

describe("collectMatches", () => {
  it("同一段落里的多处命中按出现顺序给出文档位置", () => {
    const d = doc([{ type: "paragraph", content: [text("hello world hello")] }]);
    expect(collectMatches(d, "hello")).toEqual([
      { from: 1, to: 6 },
      { from: 13, to: 18 },
    ]);
  });

  it("大小写不敏感", () => {
    const d = doc([{ type: "paragraph", content: [text("Hello HELLO")] }]);
    expect(collectMatches(d, "hello")).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
    ]);
  });

  it("跨 mark 的命中整段选中（粗体 + 普通文本）", () => {
    const d = doc([{ type: "paragraph", content: [text("he", [{ type: "bold" }]), text("llo world")] }]);
    expect(collectMatches(d, "hello")).toEqual([{ from: 1, to: 6 }]);
  });

  it("原子 inline 节点不占文本偏移，其后的命中位置仍然正确", () => {
    const d = doc([{ type: "paragraph", content: [text("ab"), { type: "hardBreak" }, text("cd")] }]);
    // 段落内容起点 1：a=1 b=2 换行=3 c=4 d=5
    expect(collectMatches(d, "cd")).toEqual([{ from: 4, to: 6 }]);
    // 原子节点不参与文本，查询词可以跨过它（与"跨 mark 整段选中"同源：按块内文本匹配）
    expect(collectMatches(d, "abcd")).toEqual([{ from: 1, to: 6 }]);
  });

  it("多块文档（标题 + 段落）各自在自己的位置上报", () => {
    const d = doc([
      { type: "heading", attrs: { level: 2 }, content: [text("标题 hello")] },
      { type: "paragraph", content: [text("正文 hello")] },
    ]);
    // 标题："标题 " 占 3 字符 → hello 从 1+3 起；标题块 nodeSize = 1+8+1 = 10，段落内容起点 11
    expect(collectMatches(d, "hello")).toEqual([
      { from: 4, to: 9 },
      { from: 14, to: 19 },
    ]);
  });

  it("空查询与无命中都返回空数组", () => {
    const d = doc([{ type: "paragraph", content: [text("abc")] }]);
    expect(collectMatches(d, "")).toEqual([]);
    expect(collectMatches(d, "zzz")).toEqual([]);
  });
});
