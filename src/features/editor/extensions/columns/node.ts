import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ColumnsNodeView, ColumnNodeView } from "./component";
import { normalizeRatio } from "./ratio";

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
      // 列宽比例：相对值（均分时每列都是 1）。renderHTML 同时写 data-ratio 与 flex，
      // 所以复制粘贴、HTML 导出、以及从 HTML 导入都能带走列宽。
      ratio: {
        default: 1,
        parseHTML: (element) => normalizeRatio(element.getAttribute("data-ratio") ?? element.style.flexGrow),
        renderHTML: (attributes) => {
          const ratio = normalizeRatio(attributes.ratio);
          return { "data-ratio": ratio, style: `flex: ${ratio} 1 0%` };
        },
      },
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
