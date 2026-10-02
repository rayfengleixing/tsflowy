import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { SubpageItem } from "@/lib/subpages";
import { SubpagesNodeView } from "./component";

// 子页面双链块（见 lib/subpages.ts）：原子只读块，内容由父页面的子页面决定。
// 块内 items 只是名称/id 快照，用于反链索引与导出；渲染时优先读实时页面树。
export const Subpages = Node.create({
  name: "subpages",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    // 当前文档所属 view id，由 EditorPage 注入（NodeView 据此查子页面）
    return { viewId: null as string | null };
  },

  addAttributes() {
    return {
      items: { default: [] as SubpageItem[] },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-subpages]" }];
  },

  renderHTML() {
    return ["div", { "data-subpages": "" }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SubpagesNodeView);
  },
});
