import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ColumnsNodeView, ColumnNodeView } from "./component";

// 分栏容器（说明书 8.2 M3：columns，子节点必须是 column）
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {};
  },

  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-columns": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnsNodeView);
  },
});

// 单个栏容器（必须放在 columns 内，内部是任意 block）
export const Column = Node.create({
  name: "column",
  group: "block",
  content: "block+",
  defining: true,
  selectable: false,

  addAttributes() {
    return {
      ratio: { default: 1 },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-column": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnNodeView);
  },
});
