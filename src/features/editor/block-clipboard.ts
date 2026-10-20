// 块级复制/剪切的剪贴板写入：纯文本之外再写一份 text/html，否则粘回编辑器（或别的富文本工具）
// 只剩一段没了结构的文字；图片这类 atom 块的纯文本本来就是空的，HTML 是它唯一能被复制出去的形态。
// 单块和多选区间走同一条序列化路径，避免两份实现粘出来的结构不一样。
import type { Editor } from "@tiptap/core";
import { DOMSerializer, Fragment, type Node as PMNode } from "@tiptap/pm/model";

import { logger } from "@/lib/logger";

/** 一串顶层块 → text/html；碰到没定义序列化器的节点会抛，那时返回 null 让调用方退回纯文本 */
export function blocksToHtml(editor: Editor, nodes: PMNode[]): string | null {
  if (nodes.length === 0) return null;
  try {
    const dom = DOMSerializer.fromSchema(editor.schema).serializeFragment(Fragment.fromArray(nodes));
    const box = document.createElement("div");
    if (typeof dom === "string") box.textContent = dom;
    else box.append(dom);
    return box.innerHTML;
  } catch (e) {
    logger.warn("block html serialize failed", e);
    return null;
  }
}

/** WebView2 里可能没有 ClipboardItem、或写入被拒：退化成纯文本，不能让整个复制失败 */
export async function writeBlockClipboard(plain: string, html: string | null): Promise<void> {
  if (!html) {
    await navigator.clipboard.writeText(plain);
    return;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } catch (e) {
    logger.warn("clipboard write failed, fallback to plain text", e);
    await navigator.clipboard.writeText(plain);
  }
}

/**
 * 复制 [from, to) 这段块。两端必须都对齐块边界——夹着半个块（例如选区落在容器内部）
 * 粘出去就是一棵残缺的子树，那种情况直接拒绝而不是偷偷补齐。
 */
export async function copyRangeToClipboard(editor: Editor, from: number, to: number): Promise<boolean> {
  const doc = editor.state.doc;
  if (to > doc.content.size || to <= from) return false;
  const slice = doc.slice(from, to);
  if (slice.openStart !== 0 || slice.openEnd !== 0) return false;
  const nodes: PMNode[] = [];
  slice.content.forEach((n) => nodes.push(n));
  await writeBlockClipboard(doc.textBetween(from, to, "\n"), blocksToHtml(editor, nodes));
  return true;
}
