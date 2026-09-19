import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MermaidNodeView } from "./component";

// Mermaid 图表块（attrs.code 存源码；渲染/编辑交互见 component.tsx）
export interface MermaidAttributes {
  code: string;
}

export const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-mermaid]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-mermaid": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },
});
