import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ImageNodeView } from "./component";

export interface ImageAttributes {
  src: string;
  alt: string;
  caption: string;
  /** 显示宽度（百分比 20-100，默认 100 = 撑满行宽） */
  width: number;
}

// 图片节点（项目说明书 8.2：自定义 image Node，attrs: src 相对路径 / alt / caption）
export const Image = Node.create({
  name: "image",

  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      caption: { default: "" },
      width: {
        default: 100,
        // 粘贴/导入 HTML img 时读取 style width 百分比
        parseHTML: (el: HTMLElement) => {
          const w = parseFloat(el.style?.width ?? "");
          return Number.isFinite(w) ? Math.max(20, Math.min(100, w)) : 100;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          const w = attrs.width as number | undefined;
          return w && w !== 100 ? { style: `width: ${w}%` } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
