// 文档结构锁定扩展（第一行 H1 标题 + 第二行分割线，均不可修改）
//
// 目标：文档固定「首行 H1 标题 + 第二行分割线」结构，二者不可编辑/删除/拖动/前插。
// 实现：
//   - LockedHeading：H1 用 contentEditable=false 的 NodeView 渲染（光标无法进入）；
//     H2/H3 保持默认可编辑视图（通过 spec.toDOM 生成元素）。
//   - DocumentStructureLock：filterTransaction 拦截一切触及保护区（[0, protectedEnd)）的
//     事务，防止改写/删除/转换/前插标题与分割线；内部名称同步事务用 STRUCTURE_SYNC_META 放行。
//   - 拖拽手柄排除见 block-drag（isProtectedStructureBlock）。
import { Extension } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/** 名称→H1 同步事务的标记：EditorPage 重命名视图时携带，绕过结构锁定 */
export const STRUCTURE_SYNC_META = "structureLockSync";

function isH1(node: ProseMirrorNode): boolean {
  return node.type.name === "heading" && (node.attrs as { level: number }).level === 1;
}

/** 保护区末端：首行 H1 的 nodeSize +（存在时）第二行分割线的 nodeSize；首行非 H1 时不保护 */
function protectedEnd(doc: ProseMirrorNode): number {
  if (doc.childCount === 0 || !isH1(doc.child(0))) return 0;
  let end = doc.child(0).nodeSize;
  if (doc.childCount > 1 && doc.child(1).type.name === "horizontalRule") {
    end += doc.child(1).nodeSize;
  }
  return end;
}

/** 事务过滤器：任何触及保护区（[0, protectedEnd)）的步骤一律拒绝。
 *  注意必须用 tr.before（步骤应用前的文档）计算保护区——步骤的 from 坐标基于该文档；
 *  用 tr.doc（步骤后的文档）会在"删除 H1"等场景下漏判。 */
export function filterStructureTransaction(tr: Transaction): boolean {
  if (!tr.docChanged) return true;
  if (tr.getMeta(STRUCTURE_SYNC_META)) return true;
  const end = protectedEnd(tr.before);
  if (end <= 0) return true;
  for (const step of tr.steps) {
    // 具体 step 子类（Replace/Delete/AddMark/Attr 等）均有 from；基类未声明，故断言取用
    const from = (step as { from?: number }).from;
    if (typeof from === "number" && from < end) return false;
  }
  return true;
}

export const DocumentStructureLock = Extension.create({
  name: "documentStructureLock",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("documentStructureLock"),
        filterTransaction: filterStructureTransaction,
      }),
    ];
  },
});

export const LockedHeading = Heading.extend({
  addNodeView() {
    return (props) => {
      const level = (props.node.attrs as { level: number }).level;
      // H2/H3：保持默认可编辑视图
      if (level !== 1) {
        const toDOM = props.node.type.spec.toDOM as ((node: ProseMirrorNode) => unknown) | undefined;
        if (typeof toDOM !== "function") return { dom: document.createElement("div") };
        const spec = toDOM(props.node);
        const tag = Array.isArray(spec) ? String(spec[0]) : "div";
        const attrs = (Array.isArray(spec) ? (spec[1] ?? {}) : {}) as Record<string, unknown>;
        const dom = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
          if (typeof v !== "string") continue;
          dom.setAttribute(k, v);
        }
        return { dom, contentDOM: dom };
      }
      // H1 标题：只读视图，文本直接渲染自 node（无 contentDOM，PM 视为原子块，光标不可进入）
      let node = props.node;
      const dom = document.createElement("h1");
      dom.setAttribute("data-node-type", "heading");
      dom.setAttribute("data-locked-title", "true");
      dom.contentEditable = "false";
      const render = () => {
        dom.textContent = node.textContent;
      };
      render();
      return {
        dom,
        update: (next) => {
          if (next.type !== node.type) return false;
          node = next;
          render();
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});
