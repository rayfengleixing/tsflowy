import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { SubPageNodeView } from "./component";

// 子页面卡片（项目说明书 8.2 M3：subPage，attrs.viewId 指向当前工作区视图）
export const SubPage = Node.create({
  name: "subPage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      viewId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-sub-page]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-sub-page": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SubPageNodeView);
  },
});
