// 顶层块多选：选中区间的数据模型 + 移动/删除的事务构造。
//
// 为什么单独成文件：块手柄、拖拽、高亮绘制都在 block-drag 的 PluginView 里（要碰 DOM），
// 而「哪几个块被选中」「搬过去落在哪个坐标」必须是纯函数才能用 vitest 跑（本仓库的
// vitest 是 node 环境，测不了 .tsx）。
//
// 约定：
//   - 只支持**连续**的顶层块区间。非连续多选会让「上移一格」失去定义，与其偷偷聚合
//     不如不给这个交互。
//   - 区间永远对齐块边界，且不得与结构锁定保护区（首行 H1 + 第二行分割线）重叠：
//     保护区由 document-structure-lock 的 filterTransaction 兜底，这里提前拒绝，
//     免得事务被静默吞掉后用户以为卡住了。
//   - 事务里带 BLOCK_SELECTION_META 表示「选中区间本身变了」；不带的（打字、撤销、
//     AI 改稿、光标移动）一律收起选择——宁可少选，不能拿过期坐标动别的块。
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

import { protectedEnd } from "./document-structure-lock";

/** setMeta 用：值为区间，`null` 清空，`undefined`（没带）表示跟随文档映射 */
export const BLOCK_SELECTION_META = "blockSelection";
export const BLOCK_SELECTION_KEY = new PluginKey<BlockSpan | null>("blockSelection");

/** 连续顶层块区间：[from, to) 两端都对齐块边界 */
export interface BlockSpan {
  from: number;
  to: number;
  count: number;
}

/** 顶层块的起始坐标与大小（含保护区，调用方自行按 protectedEnd 排除） */
export function topLevelBlocks(doc: PMNode): { pos: number; size: number }[] {
  const out: { pos: number; size: number }[] = [];
  let pos = 0;
  doc.forEach((child) => {
    out.push({ pos, size: child.nodeSize });
    pos += child.nodeSize;
  });
  return out;
}

function indexAt(blocks: { pos: number; size: number }[], pos: number): number {
  return blocks.findIndex((b) => pos >= b.pos && pos < b.pos + b.size);
}

/** 保护区里的坐标不可选、不可动、不可插入 */
export function isProtectedPos(doc: PMNode, pos: number): boolean {
  return pos < protectedEnd(doc);
}

/** 由区间首尾块的索引算出区间；含保护区则返回 null */
export function spanFromIndexes(doc: PMNode, a: number, b: number): BlockSpan | null {
  const blocks = topLevelBlocks(doc);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo < 0 || hi >= blocks.length) return null;
  if (isProtectedPos(doc, blocks[lo].pos)) return null;
  return { from: blocks[lo].pos, to: blocks[hi].pos + blocks[hi].size, count: hi - lo + 1 };
}

/** pos 所在的那个顶层块（保护区内或越界返回 null） */
export function blockSpanAt(doc: PMNode, pos: number): BlockSpan | null {
  const blocks = topLevelBlocks(doc);
  const i = indexAt(blocks, pos);
  if (i < 0) return null;
  return spanFromIndexes(doc, i, i);
}

/** Shift 点手柄：从锚点块扩到目标块；锚点已被删就退回只含目标块 */
export function expandSpan(doc: PMNode, anchorFrom: number | null, targetPos: number): BlockSpan | null {
  const blocks = topLevelBlocks(doc);
  const target = indexAt(blocks, targetPos);
  if (target < 0) return null;
  if (anchorFrom === null) return spanFromIndexes(doc, target, target);
  const anchor = indexAt(blocks, anchorFrom);
  if (anchor < 0) return spanFromIndexes(doc, target, target);
  return spanFromIndexes(doc, anchor, target);
}

/** 区间对应的首尾块索引 */
function spanIndexes(doc: PMNode, span: BlockSpan): [number, number] | null {
  const blocks = topLevelBlocks(doc);
  const lo = indexAt(blocks, span.from);
  const hi = indexAt(blocks, span.to - 1);
  if (lo < 0 || hi < 0 || lo > hi) return null;
  return [lo, hi];
}

/**
 * 往哪个坐标搬：`insertBefore` 是原 doc 坐标，语义为「插到占据该坐标的块之前」，
 * 合法值只有顶层块起点或 doc.content.size（拖拽的 before/after 与 Alt 上下移都归一到它）。
 */
export function buildSpanMoveTr(state: EditorState, span: BlockSpan, insertBefore: number): Transaction | null {
  const doc = state.doc;
  if (span.to > doc.content.size || doc.nodeAt(span.from) === null) return null;
  if (isProtectedPos(doc, span.from) || isProtectedPos(doc, insertBefore)) return null;
  // 落回原地：insertBefore 落在自己区间内（往下搬一格时目标就是自己的下一格）
  if (insertBefore >= span.from && insertBefore < span.to) return null;
  const moved = doc.slice(span.from, span.to);
  // 只有两端都对齐块边界才敢整块搬走；夹着半个块会让内容模型出错
  if (moved.openStart !== 0 || moved.openEnd !== 0) return null;
  const size = span.to - span.from;
  // 先删后插，所以要减掉「插在目标之前」那部分被删掉的宽度
  const removedBefore = span.to <= insertBefore ? size : 0;
  const target = insertBefore - removedBefore;
  if (isProtectedPos(doc, target)) return null;
  const tr = state.tr.delete(span.from, span.to);
  const $t = tr.doc.resolve(target);
  if (!$t.parent.contentMatchAt($t.index()).matchFragment(moved.content)) {
    return null;
  }
  tr.insert(target, moved.content);
  // 选中跟着搬走：不显式带上区间的话，删除会让 PM 把映射后的选区塌到删除点
  tr.setMeta(BLOCK_SELECTION_META, { from: target, to: target + size, count: span.count });
  return tr;
}

/** Alt+↑/↓ 的目标坐标；搬不动（到头、撞保护区）返回 null 让按键透传 */
export function spanMoveTarget(doc: PMNode, span: BlockSpan, dir: -1 | 1): number | null {
  const blocks = topLevelBlocks(doc);
  const idx = spanIndexes(doc, span);
  if (!idx) return null;
  const [lo, hi] = idx;
  if (dir < 0) {
    if (lo <= 0) return null;
    const prev = blocks[lo - 1];
    // 前一格是保护区（H1 或分割线）时，prev.pos 也在保护区内：整段搬不动
    if (isProtectedPos(doc, prev.pos)) return null;
    return prev.pos;
  }
  if (hi >= blocks.length - 1) return null;
  const next = blocks[hi + 1];
  return next.pos + next.size;
}

/** 删除整个区间并收起选择；带保护区一律拒绝 */
export function buildSpanDeleteTr(state: EditorState, span: BlockSpan): Transaction | null {
  if (span.to > state.doc.content.size) return null;
  if (isProtectedPos(state.doc, span.from)) return null;
  if (state.doc.nodeAt(span.from) === null) return null;
  const tr = state.tr.delete(span.from, span.to);
  tr.setMeta(BLOCK_SELECTION_META, null);
  return tr;
}

/** 把整段原样再多插一份，插在区间之后；选区跟着搬到副本上，方便连按重复或就地改副本 */
export function buildSpanDuplicateTr(state: EditorState, span: BlockSpan): Transaction | null {
  const doc = state.doc;
  if (span.to > doc.content.size || doc.nodeAt(span.from) === null) return null;
  if (isProtectedPos(doc, span.from)) return null;
  const copied = doc.slice(span.from, span.to);
  if (copied.openStart !== 0 || copied.openEnd !== 0) return null;
  const tr = state.tr;
  const $t = tr.doc.resolve(span.to);
  if (!$t.parent.contentMatchAt($t.index()).matchFragment(copied.content)) return null;
  tr.insert(span.to, copied.content);
  const size = span.to - span.from;
  tr.setMeta(BLOCK_SELECTION_META, { from: span.to, to: span.to + size, count: span.count });
  return tr;
}

/** 当前要动哪个区间：有多选就用多选，否则退回光标所在的单个顶层块 */
export function spanForAction(state: EditorState): BlockSpan | null {
  const stored = BLOCK_SELECTION_KEY.getState(state);
  if (stored) return stored;
  return blockSpanAt(state.doc, state.selection.from);
}

export function blockSelectionPlugin(): Plugin<BlockSpan | null> {
  return new Plugin({
    key: BLOCK_SELECTION_KEY,
    state: {
      init: (): BlockSpan | null => null,
      apply(tr, prev): BlockSpan | null {
        const meta: unknown = tr.getMeta(BLOCK_SELECTION_META);
        if (meta !== undefined) return meta === null ? null : (meta as BlockSpan);
        // 不带本模块 meta 的事务一律收起选择：打字、撤销、AI 改稿都会在区间里换掉块，
        // 留着过期坐标再按一次退格就是误删整块。宁可少选，不能错删。
        return prev && !tr.docChanged && !tr.selectionSet ? prev : null;
      },
    },
  });
}
