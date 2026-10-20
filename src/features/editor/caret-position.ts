import type { Node as PMNode } from "@tiptap/pm/model";
import type { CaretMark } from "@/lib/caret-memory";

/**
 * 光标位置 ↔ 记忆的换算。
 * 为什么不直接存绝对 pos：文档一改（别处加删一段），pos 就整体漂移，光标会跳到莫名其妙的地方。
 * 存「顶层第几块 + 块内第几个字符」，改动只影响它自己那一块，恢复时按现状夹紧即可。
 */

/** 取一份光标记忆（滚动位置由调用方在落库时补）；光标不在正文里返回 null */
export function captureCaretMark(doc: PMNode, head: number): Omit<CaretMark, "scrollTop"> | null {
  if (doc.childCount === 0) return null;
  const pos = Math.min(Math.max(Math.trunc(head), 0), doc.content.size);
  const $h = doc.resolve(pos);
  if ($h.depth === 0) return null;
  const block = Math.min($h.index(0), doc.childCount - 1);
  return { block, offset: doc.textBetween($h.start(1), pos).length };
}

/**
 * 把记忆换回当前文档里的绝对位置。块号越界夹到最后一块，偏移超出块内正文夹到块尾：
 * 宁可回个近似位置，也不因为文档变短而完全不恢复。
 */
export function resolveCaretPos(doc: PMNode, mark: Pick<CaretMark, "block" | "offset">): number | null {
  if (doc.childCount === 0) return null;
  const block = Math.min(Math.max(Math.trunc(mark.block), 0), doc.childCount - 1);
  let blockStart = 0;
  for (let i = 0; i < block; i++) blockStart += doc.child(i).nodeSize;
  const node = doc.child(block);
  const contentStart = blockStart + 1;
  const blockEnd = blockStart + node.nodeSize - 1;
  const pos = positionForChars(node, contentStart, Math.max(0, Math.trunc(mark.offset)));
  return Math.min(Math.max(pos, contentStart), blockEnd);
}

/** 块内第 chars 个字符的绝对位置：逐 text 节点累加，跨 mark 的分散 text 也能对上 */
function positionForChars(block: PMNode, contentStart: number, chars: number): number {
  let seen = 0;
  let out = -1;
  block.descendants((node, rel) => {
    if (out >= 0) return false;
    if (!node.isText) return true;
    const len = node.text?.length ?? 0;
    if (seen + len >= chars) {
      // descendants 给的 rel 已经是「相对块内容起点」的偏移（首层含开标签那一位已折进去）
      out = contentStart + rel + (chars - seen);
      return false;
    }
    seen += len;
    return false;
  });
  if (out >= 0) return out;
  return contentStart + chars;
}
