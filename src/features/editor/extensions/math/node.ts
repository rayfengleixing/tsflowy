import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MathNodeView } from "./component";

// KaTeX 数学公式块（项目说明书 8.2 M3：math，attrs.tex 存 TeX 源码）
export interface MathAttributes {
  tex: string;
}

export const Math = Node.create({
  name: "math",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      tex: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-math]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-math": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },
});
