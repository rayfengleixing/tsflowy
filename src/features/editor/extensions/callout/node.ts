import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CalloutNodeView } from "./component";

// 提示框容器（项目说明书 8.2 M3：callout，嵌套 block 内容）
export type CalloutColor = "blue" | "green" | "orange" | "red" | "purple" | "yellow";

const COLORS: CalloutColor[] = ["blue", "green", "orange", "red", "purple", "yellow"];

/** 从粘贴进来的 DOM 里角色名：别的编辑器或坏数据一律退回蓝 */
function colorFromElement(element: HTMLElement): CalloutColor {
  const raw = element.getAttribute("data-color");
  return COLORS.find((color) => color === raw) ?? "blue";
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    // 只声明 default 的话，序列化出的 HTML 不带这两个属性：复制粘贴一次就把 emoji 和颜色丢光
    return {
      emoji: {
        default: "💡",
        parseHTML: (element) => {
          const raw = element.getAttribute("data-emoji");
          return raw === null || raw === "" ? "💡" : raw;
        },
        renderHTML: ({ emoji }: { emoji: string }) => ({ "data-emoji": emoji }),
      },
      color: {
        default: "blue" as CalloutColor,
        parseHTML: (element) => colorFromElement(element),
        renderHTML: ({ color }: { color: CalloutColor }) => ({ "data-color": color }),
      },
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
