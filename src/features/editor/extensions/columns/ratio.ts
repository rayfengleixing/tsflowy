// 分栏列宽（column.ratio）的纯逻辑：节点属性读写、拖拽换算、事务构造。
// 单独成模块的原因：ratio 原先只是 addAttributes 里声明了 default 1，渲染端一律 flex-1 等分，
// 既拖不动也存不住；把数学与事务从 React NodeView 里拆出来才能在 node 环境下直接单测。
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

/** 单列占比下限：拖到总宽的 8% 就停，压成一条线后既看不见也点不进去 */
export const MIN_FRACTION = 0.08;
/** 存进 attrs 的 ratio 允许范围：相对值本身没有量纲，只挡坏数据 */
const MIN_RATIO = 0.05;
const MAX_RATIO = 20;
/** 浮点占比比较容差 */
const EPSILON = 1e-9;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 把任意来源（attrs / data-ratio / flex-grow）的值收进合法区间，坏数据退回 1 */
export function normalizeRatio(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, n)));
}

/** 均分：相对值取 1×列数，总和恒等于列数，写进 markdown 的注释标记也好看 */
export function evenRatios(count: number): number[] {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, () => 1);
}

/** 任意一组值 → 长度与列数一致且每项合法的比例数组 */
export function normalizeRatios(values: readonly unknown[], count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(normalizeRatio(values[i]));
  return out;
}

/** 拖动第 index 条分隔条（位于 index-1 与 index 两列之间）后的新比例。
 *  delta 是「占整行宽度的比例」，正值把 index 列挤窄、把 index-1 列放宽。
 *  其余列宽按各自占比等比缩放不变，总和保持不变（只 redistribution，不改放大或缩小整行）。 */
export function shiftRatios(ratios: readonly number[], index: number, delta: number): number[] | null {
  if (ratios.length < 2) return null;
  if (index < 1 || index >= ratios.length) return null;
  const amount = Number(delta);
  if (!Number.isFinite(amount)) return null;
  const total = ratios.reduce((sum, r) => sum + normalizeRatio(r), 0);
  if (!(total > 0)) return null;
  const fractions = ratios.map((r) => normalizeRatio(r) / total);
  const left = fractions[index - 1];
  const right = fractions[index];
  // 每侧最多让出「自己占比 − 下限」：左列让出 → 分隔条左移，右列让出 → 分隔条右移
  // （占比是浮点，比较一律带 epsilon，否则贴到下限再拖会算出 ±1e-17 的「还能动」）
  const lower = -(left - MIN_FRACTION);
  const upper = right - MIN_FRACTION;
  if (lower > EPSILON || upper < -EPSILON) return null; // 比下限还窄的坏数据不再参与拖动
  const moved = Math.min(Math.max(amount, lower), upper);
  if (Math.abs(moved) < EPSILON) return null;
  const next = fractions.slice();
  next[index - 1] = left + moved;
  next[index] = right - moved;
  // 乘回原来的总和：只重新分配，不整体放大或缩小
  return next.map((f) => round(f * total));
}

/** 分栏容器在 doc 中的位置：从任一内部位置向上找 columns 祖先 */
export function columnsAncestorPos(doc: PMNode, pos: number): number | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    if ($pos.node(depth).type.name === "columns") return $pos.before(depth);
  }
  return null;
}

/** columns 容器内第 child 列的文档位置：容器起点 + 1（进入容器）+ 内容内偏移 */
function childPos(columnsPos: number, offset: number): number {
  return columnsPos + 1 + offset;
}

/** 只有 columns 容器本身才参与列宽计算 */
function columnsNode(doc: PMNode, pos: number): PMNode | null {
  const node = docAt(doc, pos);
  return node !== null && node.type.name === "columns" ? node : null;
}

/** 某列在其 columns 父节点中的序号；不在该容器内返回 null */
export function columnIndexOf(doc: PMNode, columnsPos: number, childPosValue: number): number | null {
  const node = columnsNode(doc, columnsPos);
  if (!node) return null;
  let found: number | null = null;
  node.forEach((child, offset, index) => {
    if (child.type.name === "column" && childPos(columnsPos, offset) === childPosValue) found = index;
  });
  return found;
}

/** 读出 columns 容器各列的 ratio；不是 columns 返回 null */
export function readRatios(doc: PMNode, columnsPos: number): number[] | null {
  const node = columnsNode(doc, columnsPos);
  if (!node) return null;
  const out: number[] = [];
  node.forEach((child) => {
    out.push(normalizeRatio(child.attrs.ratio));
  });
  return out;
}

/** 用给定比例改写各列 attrs；pos 不是 columns 或长度不符返回 null */
export function buildRatiosTr(state: EditorState, columnsPos: number, ratios: readonly number[]): Transaction | null {
  const node = columnsNode(state.doc, columnsPos);
  if (!node) return null;
  if (node.childCount !== ratios.length || node.childCount === 0) return null;
  const clean = normalizeRatios(ratios, node.childCount);
  let tr = state.tr;
  node.forEach((child, offset, index) => {
    if (child.type.name !== "column") return;
    tr = tr.setNodeMarkup(childPos(columnsPos, offset), undefined, { ...child.attrs, ratio: clean[index] });
  });
  return tr.steps.length > 0 ? tr : null;
}

/** nodeAt 对越界坐标抛 RangeError，先夹一道 */
function docAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  return doc.nodeAt(pos);
}
