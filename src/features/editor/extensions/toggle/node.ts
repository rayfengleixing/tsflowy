import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ToggleNodeView } from "./component";

// 折叠列表容器（项目说明书 8.2 M3：toggle，collapsed 控制展开/收起）
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      collapsed: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-toggle": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleNodeView);
  },
});
