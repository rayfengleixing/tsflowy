import { describe, it, expect } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { filterStructureTransaction, STRUCTURE_SYNC_META } from "./document-structure-lock";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    paragraph: { content: "inline*", group: "block" },
    horizontalRule: { group: "block", atom: true },
    text: { group: "inline" },
  },
});

function doc(json: Parameters<typeof schema.nodeFromJSON>[0]): PMNode {
  return schema.nodeFromJSON(json);
}

const docJson = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
    { type: "horizontalRule" },
    { type: "paragraph", content: [{ type: "text", text: "正文" }] },
  ],
};

function tr() {
  return EditorState.create({ schema, doc: doc(docJson) }).tr;
}

describe("filterStructureTransaction 结构锁定", () => {
  it("空事务放行", () => {
    expect(filterStructureTransaction(tr())).toBe(true);
  });

  it("放行：编辑分割线后的正文", () => {
    // 正文段落 [5,7)，删除其中文本
    expect(filterStructureTransaction(tr().delete(5, 7))).toBe(true);
  });

  it("放行：在分割线后插入段落", () => {
    const t = tr();
    t.insert(5, schema.nodes.paragraph.create(null, schema.text("新段落")));
    expect(filterStructureTransaction(t)).toBe(true);
  });

  it("放行：带同步标记的 H1 文本替换（重命名反向同步）", () => {
    const t = tr().delete(1, 3);
    t.setMeta(STRUCTURE_SYNC_META, true);
    expect(filterStructureTransaction(t)).toBe(true);
  });

  it("拒绝：删除 H1 标题文本", () => {
    expect(filterStructureTransaction(tr().delete(1, 3))).toBe(false);
  });

  it("拒绝：删除整个 H1 标题节点", () => {
    expect(filterStructureTransaction(tr().delete(0, 4))).toBe(false);
  });

  it("拒绝：删除第二行分割线", () => {
    expect(filterStructureTransaction(tr().delete(4, 5))).toBe(false);
  });

  it("拒绝：在 H1 标题前插入内容", () => {
    const t = tr();
    t.insert(0, schema.nodes.paragraph.create(null, schema.text("前插")));
    expect(filterStructureTransaction(t)).toBe(false);
  });

  it("拒绝：在标题与分割线之间插入内容", () => {
    const t = tr();
    t.insert(4, schema.nodes.paragraph.create(null, schema.text("中间")));
    expect(filterStructureTransaction(t)).toBe(false);
  });

  it("拒绝：把 H1 标题转换为普通段落", () => {
    const t = tr();
    t.setNodeMarkup(0, schema.nodes.paragraph);
    expect(filterStructureTransaction(t)).toBe(false);
  });

  it("旧文档（仅 H1 无分割线）：标题仍保护，其后可编辑", () => {
    const d = doc({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      ],
    });
    const state = EditorState.create({ schema, doc: d });
    expect(filterStructureTransaction(state.tr.delete(1, 3))).toBe(false);
    expect(filterStructureTransaction(state.tr.delete(5, 7))).toBe(true);
  });

  it("首行非 H1 的文档不锁定（如导入文档）", () => {
    const d = doc({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "开头" }] }],
    });
    const state = EditorState.create({ schema, doc: d });
    expect(filterStructureTransaction(state.tr.delete(1, 3))).toBe(true);
  });
});
