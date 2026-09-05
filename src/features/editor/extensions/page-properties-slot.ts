import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * PagePropertiesSlot：在文档首个 H1 之后渲染挂载点 div（widget decoration），
 * React 侧 PageProperties 通过 portal 渲染进该 div —— 实现「页面属性位于标题下方」。
 * 文档没有 H1 时不渲染挂载点（属性区随标题存在）。
 */
export const PagePropertiesSlot = Extension.create({
  name: "pagePropertiesSlot",

  addProseMirrorPlugins() {
    // 元素缓存在插件闭包内（每个 editor 实例独立）。PM 对 widget 的默认 eq 是
    // DOM 节点同一性比较 —— 每次重建 decoration 返回同一元素，portal 目标才不会被反复重建。
    let slotEl: HTMLElement | null = null;

    const slotPos = (doc: ProseMirrorNode): number | null => {
      let found: number | null = null;
      doc.forEach((child, offset) => {
        if (found === null && child.type.name === "heading" && (child.attrs as { level: number }).level === 1) {
          found = offset + child.nodeSize;
        }
      });
      return found;
    };

    return [
      new Plugin({
        key: new PluginKey("pagePropertiesSlot"),
        props: {
          decorations(state) {
            const pos = slotPos(state.doc);
            if (pos === null) return DecorationSet.empty;
            if (!slotEl?.isConnected) {
              slotEl = document.createElement("div");
              slotEl.dataset.pagePropertiesSlot = "";
              slotEl.setAttribute("contenteditable", "false");
            }
            return DecorationSet.create(state.doc, [Decoration.widget(pos, () => slotEl!, { side: -1 })]);
          },
        },
      }),
    ];
  },
});
