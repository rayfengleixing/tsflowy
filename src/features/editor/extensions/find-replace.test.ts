import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import { collectMatches, scanMatches } from "./find-replace";

// 位置映射是这块逻辑唯一容易出错的地方：跨 mark、原子 inline 节点、多块文档
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    text: { group: "inline" },
    hardBreak: { inline: true, group: "inline" },
    image: { inline: true, group: "inline", attrs: { src: { default: "" } } },
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

  it("原子 inline 节点以占位符参与匹配，不再产生跨原子的假命中", () => {
    const d = doc([{ type: "paragraph", content: [text("ab"), { type: "hardBreak" }, text("cd")] }]);
    // 段落内容起点 1：a=1 b=2 换行=3 c=4 d=5
    expect(collectMatches(d, "cd")).toEqual([{ from: 4, to: 6 }]);
    // hardBreak 占一个字符位：跨它的 "abcd" 不再误命中（旧实现按 textContent 拼接会命中）
    expect(collectMatches(d, "abcd")).toEqual([]);
    // 非文本 atom（image，leaf nodeSize=1）同样以占位符隔离：a=1 b=2 image=3 c=4 d=5
    const d2 = doc([{ type: "paragraph", content: [text("ab"), { type: "image", attrs: { src: "x" } }, text("cd")] }]);
    expect(collectMatches(d2, "abcd")).toEqual([]);
    expect(collectMatches(d2, "cd")).toEqual([{ from: 4, to: 6 }]);
  });

  it("查询词含 \\n 时可跨块匹配，块边界映射到兄弟块起始位", () => {
    const d = doc([
      { type: "paragraph", content: [text("foo bar")] },
      { type: "paragraph", content: [text("baz")] },
    ]);
    // 首块 nodeSize=9 → 次块起始 pos 9；"bar\nbaz" = 5..7 + 边界 9 + 10..12
    expect(collectMatches(d, "bar\nbaz")).toEqual([{ from: 5, to: 13 }]);
  });

  it("相邻块的尾首文本不会被拼接成跨块假命中", () => {
    const d = doc([
      { type: "paragraph", content: [text("ab")] },
      { type: "paragraph", content: [text("cd")] },
    ]);
    expect(collectMatches(d, "abcd")).toEqual([]);
  });

  it("空查询与无命中都返回空数组", () => {
    const d = doc([{ type: "paragraph", content: [text("abc")] }]);
    expect(collectMatches(d, "")).toEqual([]);
    expect(collectMatches(d, "zzz")).toEqual([]);
  });
});

describe("scanMatches 匹配选项（区分大小写 / 全词）", () => {
  it("caseSensitive：只有大小写完全一致才命中，默认仍不敏感", () => {
    const d = doc([{ type: "paragraph", content: [text("Hello HELLO hello")] }]);
    expect(scanMatches(d, "hello", { caseSensitive: true }).matches).toEqual([{ from: 13, to: 18 }]);
    expect(scanMatches(d, "hello").matches).toHaveLength(3);
  });

  it("wholeWord：拉丁词/数字受边界约束", () => {
    const d = doc([{ type: "paragraph", content: [text("the there other 123 a123")] }]);
    // "the" 独立命中；"there"（后接词字符）与 "other"（前接词字符）不算全词
    expect(scanMatches(d, "the", { wholeWord: true }).matches).toEqual([{ from: 1, to: 4 }]);
    // "123" 独立命中；"a123" 中前接 a 不命中
    expect(scanMatches(d, "123", { wholeWord: true }).matches).toEqual([{ from: 17, to: 20 }]);
  });

  it("wholeWord 对中日韩文本不生效：CJK 视为非词字符", () => {
    const d = doc([{ type: "paragraph", content: [text("这是一个测试文本")] }]);
    expect(scanMatches(d, "测试", { wholeWord: true }).matches).toEqual([{ from: 5, to: 7 }]);
    // 汉字紧邻的拉丁词同样命中：全词只按拉丁词字符判边界
    const d2 = doc([{ type: "paragraph", content: [text("测试test中文")] }]);
    expect(scanMatches(d2, "test", { wholeWord: true }).matches).toEqual([{ from: 3, to: 7 }]);
  });

  it("wholeWord + caseSensitive 组合", () => {
    const d = doc([{ type: "paragraph", content: [text("The THE then")] }]);
    expect(scanMatches(d, "THE", { caseSensitive: true, wholeWord: true }).matches).toEqual([{ from: 5, to: 8 }]);
  });

  it("wholeWord 边界跨 mark 仍按拼接文本判定", () => {
    const d = doc([{ type: "paragraph", content: [text("hel", [{ type: "bold" }]), text("lo world")] }]);
    // "hel" 后接词字符 l → 不构成全词；"hello" 整体后接空格 → 命中
    expect(scanMatches(d, "hel", { wholeWord: true }).matches).toEqual([]);
    expect(scanMatches(d, "hello", { wholeWord: true }).matches).toEqual([{ from: 1, to: 6 }]);
  });

  it("wholeWord 下块边界（拼接分隔符 \\n）不阻断命中", () => {
    const d = doc([
      { type: "paragraph", content: [text("the")] },
      { type: "paragraph", content: [text("them")] },
    ]);
    expect(scanMatches(d, "the", { wholeWord: true }).matches).toEqual([{ from: 1, to: 4 }]);
  });
});
