import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CalloutNodeView } from "./component";

// 提示框容器（项目说明书 8.2 M3：callout，嵌套 block 内容）
export type CalloutColor = "blue" | "green" | "orange" | "red" | "purple" | "yellow";

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      emoji: { default: "💡" },
      color: { default: "blue" as CalloutColor },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-callout": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },
});
