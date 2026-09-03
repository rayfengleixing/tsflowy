import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { OutlineNodeView } from "./component";

// 目录（项目说明书 8.2 M3：outline，只读 atom，渲染时扫描文档 heading）
export const Outline = Node.create({
  name: "outline",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {};
  },

  parseHTML() {
    return [{ tag: "div[data-outline]" }];
  },

  renderHTML() {
    return ["div", { "data-outline": "" }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(OutlineNodeView);
  },
});
