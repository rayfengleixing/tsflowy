import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

import {
  BLOCK_SELECTION_META,
  BLOCK_SELECTION_KEY,
  blockSelectionPlugin,
  blockSpanAt,
  buildSpanDeleteTr,
  buildSpanMoveTr,
  expandSpan,
  isProtectedPos,
  spanForAction,
  spanFromIndexes,
  spanMoveTarget,
  topLevelBlocks,
  type BlockSpan,
} from "./block-selection";
import { filterStructureTransaction } from "./document-structure-lock";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    horizontalRule: { group: "block", atom: true },
    banner: { group: "block", content: "block+" },
    text: { group: "inline" },
  },
  marks: { bold: {} },
});

// 保护区 = H1「标题」(4) + 分割线(1)，正文块 a/b/c/d 各 3：起点 5/8/11/14，全长 17
function lockedDoc(): PMNode {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
      { type: "horizontalRule" },
      { type: "paragraph", content: [{ type: "text", text: "a" }] },
      { type: "paragraph", content: [{ type: "text", text: "b" }] },
      { type: "paragraph", content: [{ type: "text", text: "c" }] },
      { type: "paragraph", content: [{ type: "text", text: "d" }] },
    ],
  });
}

// 首行不是 H1 → 没有保护区；a/b/c/d 起点 0/3/6/9，全长 12
function plainDoc(): PMNode {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "a" }] },
      { type: "paragraph", content: [{ type: "text", text: "b" }] },
      { type: "paragraph", content: [{ type: "text", text: "c" }] },
      { type: "paragraph", content: [{ type: "text", text: "d" }] },
    ],
  });
}

const textOf = (n: PMNode) => n.textContent;
const body = (doc: PMNode) => Array.from({ length: doc.childCount }, (_, i) => textOf(doc.child(i)));
/** index 0=标题、1=分割线、2..5=a b c d */
function blockPos(doc: PMNode, index: number): number {
  return topLevelBlocks(doc)[index].pos;
}

function lockedState() {
  return EditorState.create({ schema, doc: lockedDoc(), plugins: [blockSelectionPlugin()] });
}
function plainState() {
  return EditorState.create({ schema, doc: plainDoc(), plugins: [blockSelectionPlugin()] });
}

describe("顶层块坐标表与保护区", () => {
  it("topLevelBlocks 给出每个顶层块的起点与大小", () => {
    expect(topLevelBlocks(plainDoc())).toEqual([
      { pos: 0, size: 3 },
      { pos: 3, size: 3 },
      { pos: 6, size: 3 },
      { pos: 9, size: 3 },
    ]);
  });

  it("保护区判定跟随首行 H1 + 第二行分割线", () => {
    const doc = lockedDoc();
    expect(isProtectedPos(doc, 0)).toBe(true); // H1
    expect(isProtectedPos(doc, blockPos(doc, 1))).toBe(true); // 分割线
    expect(isProtectedPos(doc, blockPos(doc, 2))).toBe(false); // 第一个正文块
    expect(isProtectedPos(plainDoc(), 0)).toBe(false); // 首行不是 H1 时整篇都不保护
  });

  it("blockSpanAt 只给保护区外的单个整块", () => {
    const doc = lockedDoc();
    expect(blockSpanAt(doc, 5)).toEqual({ from: 5, to: 8, count: 1 });
    expect(blockSpanAt(doc, 1)).toBeNull(); // H1 内部
    expect(blockSpanAt(doc, blockPos(doc, 1))).toBeNull(); // 分割线本身
    expect(blockSpanAt(doc, doc.content.size)).toBeNull(); // 越界
  });

  it("容器块取到的是它自己，不是里面的子块", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "banner", content: [{ type: "paragraph", content: [{ type: "text", text: "内层" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "外层" }] },
      ],
    });
    expect(blockSpanAt(doc, 3)).toEqual({ from: 0, to: doc.child(0).nodeSize, count: 1 });
  });
});

describe("区间选取", () => {
  it("spanFromIndexes 跨到保护区就整段不给选", () => {
    const doc = lockedDoc();
    expect(spanFromIndexes(doc, 3, 4)).toEqual({ from: 8, to: 14, count: 2 });
    expect(spanFromIndexes(doc, 0, 3)).toBeNull();
    expect(spanFromIndexes(doc, 1, 2)).toBeNull(); // 起点是分割线
    expect(spanFromIndexes(doc, 9, 9)).toBeNull(); // 索引不存在
  });

  it("expandSpan 双向扩选，锚点失效时退回单块", () => {
    const doc = plainDoc();
    const anchor = blockPos(doc, 1);
    expect(expandSpan(doc, anchor, blockPos(doc, 3))).toEqual({ from: anchor, to: doc.content.size, count: 3 });
    expect(expandSpan(doc, blockPos(doc, 3), anchor)).toEqual({ from: anchor, to: blockPos(doc, 3) + 3, count: 3 });
    expect(expandSpan(doc, null, anchor)).toEqual({ from: anchor, to: anchor + 3, count: 1 });
    const shrunk = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "c" }] },
        { type: "paragraph", content: [{ type: "text", text: "d" }] },
      ],
    });
    // 锚点所在块早被删了（99 已经不在这篇文档里）：退回到点的那个块
    expect(expandSpan(shrunk, 99, 1)).toEqual({ from: 0, to: 3, count: 1 });
    // 目标是保护块：不给选
    expect(expandSpan(lockedDoc(), 5, 1)).toBeNull();
  });
});

describe("整段搬移", () => {
  it("往下搬：先删后插，目标坐标要减掉被删掉的宽度", () => {
    const state = plainState();
    const span: BlockSpan = { from: 0, to: 6, count: 2 }; // a b
    const tr = buildSpanMoveTr(state, span, 9); // 插到 d 之前
    expect(body(tr!.doc)).toEqual(["c", "a", "b", "d"]);
    // 事务自带新区间：搬完仍是选中，否则 Alt 连按第二下就失效
    expect(tr!.getMeta(BLOCK_SELECTION_META)).toEqual({ from: 3, to: 9, count: 2 });
    // 删除 + 插入合成一个事务，撤销栈里是一条而不是两条
    expect(tr!.steps.length).toBe(2);
  });

  it("往上搬一格与搬到文档末尾", () => {
    const state = plainState();
    const b: BlockSpan = { from: 3, to: 6, count: 1 };
    expect(body(buildSpanMoveTr(state, b, 0)!.doc)).toEqual(["b", "a", "c", "d"]);
    expect(body(buildSpanMoveTr(state, b, state.doc.content.size)!.doc)).toEqual(["a", "c", "d", "b"]);
    // 多块区间整体上下交换，区间内部顺序不变
    const cd: BlockSpan = { from: 6, to: 12, count: 2 };
    expect(body(buildSpanMoveTr(state, cd, 3)!.doc)).toEqual(["a", "c", "d", "b"]);
  });

  it("落回原地、撞保护区、坐标过期都拒绝，而不是发一个静默无效的事务", () => {
    const state = plainState();
    const span: BlockSpan = { from: 0, to: 6, count: 2 };
    expect(buildSpanMoveTr(state, span, 3)).toBeNull(); // 目标在自己区间内
    expect(buildSpanMoveTr(state, span, state.doc.content.size)).not.toBeNull();
    const locked = lockedState();
    const ab: BlockSpan = { from: 5, to: 11, count: 2 };
    expect(buildSpanMoveTr(locked, ab, 0)).toBeNull(); // 插到 H1 之前
    expect(buildSpanMoveTr(locked, ab, blockPos(locked.doc, 1))).toBeNull(); // 插到分割线之前
    expect(buildSpanMoveTr(locked, { from: 0, to: 12, count: 4 }, 17)).toBeNull(); // 源含保护区
    expect(buildSpanMoveTr(state, { from: 99, to: 105, count: 2 }, 3)).toBeNull(); // 块已经不在了
  });

  it("内容模型不接受插入点时拒绝（PM 会吞掉这种事务）", () => {
    const strict = new Schema({
      nodes: {
        doc: { content: "paragraph* banner" },
        paragraph: schema.nodes.paragraph.spec,
        heading: schema.nodes.heading.spec,
        horizontalRule: schema.nodes.horizontalRule.spec,
        banner: schema.nodes.banner.spec,
        text: schema.nodes.text.spec,
      },
      marks: schema.spec.marks,
    });
    const doc = strict.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }] },
        { type: "paragraph", content: [{ type: "text", text: "b" }] },
        { type: "banner", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
      ],
    });
    const state = EditorState.create({ schema: strict, doc });
    const span: BlockSpan = { from: 0, to: 3, count: 1 };
    expect(buildSpanMoveTr(state, span, doc.content.size)).toBeNull(); // banner 后面不再收段落
    expect(body(buildSpanMoveTr(state, span, 6)!.doc)).toEqual(["b", "a", "x"]); // 段落区之间合法
  });

  it("spanMoveTarget 到头与撞保护区返回 null", () => {
    const locked = lockedDoc();
    const first = blockSpanAt(locked, blockPos(locked, 2))!; // a
    expect(spanMoveTarget(locked, first, -1)).toBeNull(); // 上面就是分割线
    expect(spanMoveTarget(locked, first, 1)).toBe(blockPos(locked, 4)); // b 之后
    const last = blockSpanAt(locked, blockPos(locked, 5))!; // d
    expect(spanMoveTarget(locked, last, 1)).toBeNull();
    const doc = plainDoc();
    const bc: BlockSpan = { from: 3, to: 9, count: 2 };
    expect(spanMoveTarget(doc, bc, 1)).toBe(doc.content.size);
    expect(spanMoveTarget(doc, bc, -1)).toBe(0); // 无 H1 时可以搬到最前
  });

  it("搬移事务能过结构锁定的过滤器", () => {
    const state = lockedState();
    const span = blockSpanAt(state.doc, blockPos(state.doc, 2))!; // a
    const tr = buildSpanMoveTr(state, span, state.doc.content.size)!;
    expect(filterStructureTransaction(tr)).toBe(true);
    expect(body(state.apply(tr).doc)).toEqual(["标题", "", "b", "c", "d", "a"]);
  });
});

describe("整段删除", () => {
  it("删除区间并显式收起选择", () => {
    const state = plainState();
    const tr = buildSpanDeleteTr(state, { from: 3, to: 9, count: 2 })!;
    expect(body(tr.doc)).toEqual(["a", "d"]);
    expect(tr.getMeta(BLOCK_SELECTION_META)).toBeNull();
  });

  it("含保护区或坐标过期的区间拒绝删除", () => {
    const state = lockedState();
    expect(buildSpanDeleteTr(state, { from: 0, to: 12, count: 4 })).toBeNull();
    expect(buildSpanDeleteTr(state, { from: 5, to: 11, count: 2 })).not.toBeNull();
    expect(buildSpanDeleteTr(state, { from: 5, to: 18, count: 4 })).toBeNull(); // 尾巴超出文档
    expect(buildSpanDeleteTr(state, { from: 20, to: 23, count: 1 })).toBeNull();
  });
});

describe("选中状态的存活", () => {
  // 保护区后连续的 a、b 两块
  const span: BlockSpan = { from: 5, to: 11, count: 2 };
  const select = (state: EditorState, value: BlockSpan | null) =>
    state.apply(state.tr.setMeta(BLOCK_SELECTION_META, value));

  it("显式 meta 可以设置与清空", () => {
    const state = select(lockedState(), span);
    expect(BLOCK_SELECTION_KEY.getState(state)).toEqual(span);
    expect(BLOCK_SELECTION_KEY.getState(select(state, null))).toBeNull();
  });

  it("搬移事务自带新区间，连按 Alt 不会第二下失效", () => {
    const state = select(lockedState(), span);
    const tr = buildSpanMoveTr(state, span, state.doc.content.size)!;
    expect(BLOCK_SELECTION_KEY.getState(state.apply(tr))).toEqual({ from: 11, to: 17, count: 2 });
  });

  it("不带 meta 的文档改动一律收起：留着过期坐标再按退格就是误删整块", () => {
    const state = select(lockedState(), span);
    expect(BLOCK_SELECTION_KEY.getState(state.apply(state.tr.insertText("z", 16)))).toBeNull();
    expect(BLOCK_SELECTION_KEY.getState(state.apply(state.tr.delete(8, 11)))).toBeNull();
  });

  it("光标一动就收起，纯标记事务不动区间", () => {
    const state = select(lockedState(), span);
    const clicked = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 16)));
    expect(BLOCK_SELECTION_KEY.getState(clicked)).toBeNull();
    expect(BLOCK_SELECTION_KEY.getState(state.apply(state.tr.setStoredMarks([])))).toEqual(span);
  });

  it("spanForAction 优先多选，没有多选就取光标所在整块", () => {
    const state = lockedState();
    const doc = state.doc;
    const caret = state.apply(state.tr.setSelection(TextSelection.create(doc, blockPos(doc, 3) + 1)));
    expect(spanForAction(caret)).toEqual({ from: 8, to: 11, count: 1 }); // 光标在 b
    const inTitle = caret.apply(caret.tr.setSelection(TextSelection.create(caret.doc, 1)));
    expect(spanForAction(inTitle)).toBeNull(); // 光标在 H1：不动结构
    expect(spanForAction(select(caret, span))).toEqual(span);
  });
});
