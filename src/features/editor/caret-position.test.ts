import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import type { CaretMark } from "@/lib/caret-memory";
import { captureCaretMark, resolveCaretPos } from "./caret-position";

// 位置换算是这块逻辑唯一容易错的地方：跨 mark、原子 inline、嵌套块、文档变短都得对上
const schema = new Schema({
  nodes: {
    // 正文块内容用 block*：真编辑器的 doc 也允许空文档，那正是「没有可恢复位置」的情况
    doc: { content: "block*" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    blockquote: { group: "block", content: "block+" },
    bulletList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph" },
    text: { group: "inline" },
    hardBreak: { inline: true, group: "inline" },
    image: { inline: true, group: "inline", attrs: { src: { default: "" } } },
  },
  marks: { bold: {}, italic: {} },
});

const doc = (content: unknown) => PMNode.fromJSON(schema, { type: "doc", content });
const t = (value: string, marks?: { type: string }[]) => ({ type: "text", text: value, marks });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const bq = (...content: unknown[]) => ({ type: "blockquote", content });
const li = (text: string) => ({ type: "listItem", content: [p(t(text))] });
const mark = (block: number, offset: number): CaretMark => ({ block, offset, scrollTop: 0 });

/** 往返一次：记忆 → 位置，必须回到原处 */
function roundTrip(d: PMNode, head: number): void {
  const captured = captureCaretMark(d, head);
  if (!captured) throw new Error(`未取到记忆（head=${head}）`);
  expect(resolveCaretPos(d, captured)).toBe(head);
}

describe("captureCaretMark", () => {
  it("记的是顶层块号与块内字符数", () => {
    const d = doc([p(t("标题段")), p(t("第一二三"))]);
    // 块 0 nodeSize = 1+3+1 = 5 → 块 1 内容起点 6，「第一|二三」= 8
    expect(captureCaretMark(d, 8)).toEqual({ block: 1, offset: 2 });
  });

  it("跨 mark 的文本按纯文本字符计数", () => {
    const d = doc([p(t("he", [{ type: "bold" }]), t("llo"))]);
    // 块内容起点 1：h=1 e=2 → he|llo 的光标在 3，前面 2 个字符
    expect(captureCaretMark(d, 3)).toEqual({ block: 0, offset: 2 });
  });

  it("嵌套块归到它的顶层块，偏移按整棵子树计数", () => {
    const d = doc([p(t("引导")), bq(p(t("hello world")))]);
    // 块 0 nodeSize 4 → 引用块从 4 起，其内容起点 5、内部段落内容起点 6
    // "hello |world" = 12，相对引用块内容起点 5 是 6 个字符
    expect(captureCaretMark(d, 12)).toEqual({ block: 1, offset: 6 });
  });

  it("原子 inline 节点不计入字符，但位置照样对得上", () => {
    const d = doc([p(t("ab"), { type: "image", attrs: { src: "a.png" } }, t("cd"))]);
    // a=1 b=2 图=3 c=4 d=5 → ab…c|d 在 5，纯文本只数了 "abc"
    expect(captureCaretMark(d, 5)).toEqual({ block: 0, offset: 3 });
  });

  it("空段落记为块内第 0 个字符", () => {
    expect(captureCaretMark(doc([p()]), 1)).toEqual({ block: 0, offset: 0 });
  });

  it("光标落在块之间或空文档时不给记忆", () => {
    expect(captureCaretMark(doc([p(t("abc"))]), 0)).toBeNull();
    expect(captureCaretMark(doc([]), 0)).toBeNull();
  });
});

describe("resolveCaretPos", () => {
  it("同文档往返：标题、正文、列表里的光标都还原成原位置", () => {
    const d = doc([
      { type: "heading", attrs: { level: 2 }, content: [t("小节标题")] },
      p(t("第一段正文")),
      { type: "bulletList", content: [li("列表项")] },
    ]);
    roundTrip(d, 5); // 标题块内容起点 1，第 4 个字后
    roundTrip(d, 10); // 第二块内容起点 7，第 3 个字后
    roundTrip(d, 18); // 列表项：段落内容起点 16，第 2 个字后
    roundTrip(doc([p(t("引导")), bq(p(t("hello world")))]), 12); // 嵌套块里的光标
  });

  it("块内文本变短：夹到该块末尾，不跳到别的块", () => {
    const d = doc([p(t("短"))]);
    expect(resolveCaretPos(d, mark(0, 30))).toBe(2);
  });

  it("块号越界（文档被删了几段）：落到最后一块", () => {
    const d = doc([p(t("只剩这段")), p(t("和第二段"))]);
    // 块 0 nodeSize 6 → 块 1 内容起点 7，第 1 个字后 = 8
    expect(resolveCaretPos(d, mark(40, 1))).toBe(8);
  });

  it("空文档没有可去的位置", () => {
    expect(resolveCaretPos(doc([]), mark(0, 0))).toBeNull();
  });

  it("结果始终落在目标块的内容区间内", () => {
    const d = doc([p(t("一二三")), bq(p(t("四五六")))]);
    // 引用块占 5..12：内容起点 6、内部段落里的文本从 7 起，块内最后一个合法位置 11
    expect(resolveCaretPos(d, mark(1, 0))).toBe(7);
    expect(resolveCaretPos(d, mark(1, 3))).toBe(10);
    expect(resolveCaretPos(d, mark(1, 99))).toBe(11);
  });
});
