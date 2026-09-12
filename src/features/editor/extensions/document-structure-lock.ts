// 文档结构锁定扩展（第一行 H1 标题 + 第二行分割线）
//
// 目标：文档固定「首行 H1 标题 + 第二行分割线」结构，二者不可删除/转换/拖动/前插；
// 但 H1 的文本内容可编辑——H1 即文档标题，编辑内容会同步为视图名称。
// 实现：
//   - LockedHeading：H1/H2/H3 均渲染为标准可编辑标题视图（H1 带 data-locked-title 标记）；
//     结构锁定由下方事务过滤保证，而非只读 NodeView。
//   - DocumentStructureLock：filterTransaction 拦截破坏保护区（[0, protectedEnd)）结构的事务，
//     但放行 H1 内部纯文本替换与格式标记；Enter 在 H1 内时改为跳到下一内容块（不做 split）。
//   - 拖拽手柄排除见 block-drag（isProtectedStructureBlock）。
import { Extension } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";

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

/** 事务过滤器：保护 H1 节点与第二行分割线的结构，放行 H1 内部文本/格式编辑。
 *  注意必须用 tr.before（步骤应用前的文档）计算保护区——步骤的 from 坐标基于该文档；
 *  用 tr.doc（步骤后的文档）会在"删除 H1"等场景下漏判。 */
export function filterStructureTransaction(tr: Transaction): boolean {
  if (!tr.docChanged) return true;
  if (tr.getMeta(STRUCTURE_SYNC_META)) return true;
  const doc = tr.before;
  if (doc.childCount === 0 || !isH1(doc.child(0))) return true;
  const h1 = doc.child(0);
  const h1InnerEnd = h1.nodeSize - 1; // H1 内部文本的最大 position（节点闭合位前）
  const end = protectedEnd(doc);
  for (const step of tr.steps) {
    const from = (step as { from?: number }).from ?? 0;
    // 格式标记（加粗/颜色等）不改变结构，一律放行
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue;
    if (from >= end) continue; // 保护区之外
    // H1 内部纯文本替换（含插入/删除/整段替换）：完全落在 H1 文本区间内且新内容是
    // inline 级（文本/标记）→ 放行；slice 含块节点（如回车分割 H1、粘贴整块）→ 拒绝
    if (step instanceof ReplaceStep && from >= 1 && step.to <= h1InnerEnd) {
      const slice = step.slice?.content;
      const textOnly = !slice || slice.content.length === 0 || slice.content.every((n) => n.isInline);
      if (textOnly) continue;
    }
    return false;
  }
  return true;
}

export const DocumentStructureLock = Extension.create({
  name: "documentStructureLock",

  addKeyboardShortcuts() {
    return {
      // H1 内回车：结束标题编辑，光标跳到 H1 后第一个非分割线内容块；
      // 后面没有内容块时新建空段落（默认 splitBlock 会把 H1 一分为二，与结构锁定冲突）
      Enter: () => {
        const editor = this.editor;
        const { doc, selection } = editor.state;
        if (doc.childCount === 0 || !isH1(doc.child(0))) return false;
        const h1 = doc.child(0);
        const inH1 = selection.empty && selection.from >= 1 && selection.from <= h1.nodeSize - 1;
        if (!inH1) return false;
        let pos = h1.nodeSize;
        let idx = 1;
        while (idx < doc.childCount && doc.child(idx).type.name === "horizontalRule") {
          pos += doc.child(idx).nodeSize;
          idx++;
        }
        let tr = editor.state.tr;
        if (idx >= doc.childCount) {
          const paragraphType = editor.schema.nodes.paragraph ?? null;
          if (!paragraphType) return false;
          tr = tr.insert(doc.content.size, paragraphType.create());
        }
        tr = tr.setSelection(TextSelection.create(tr.doc, pos));
        editor.view.dispatch(tr);
        return true;
      },
    };
  },

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
      // H1 标记为锁定标题（内容可编辑，但结构不可变；供样式/拖拽排除引用）
      if (level === 1) dom.setAttribute("data-locked-title", "true");
      return { dom, contentDOM: dom };
    };
  },
});
