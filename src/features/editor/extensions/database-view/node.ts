import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { DatabaseViewNodeView } from "./component";

// 数据库视图嵌入节点（项目说明书 8.2 databaseView：内嵌 Grid/Board/Calendar，M5 核心）
export const DatabaseView = Node.create({
  name: "databaseView",

  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      viewId: { default: null },
      name: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-database-view]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-database-view": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DatabaseViewNodeView);
  },
});
