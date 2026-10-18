// AI 答案里的 TeX 公式（`$…$` 行内、`$$…$$` 独立）→ 交给 KaTeX 渲染的占位节点。
// 只碰 text 节点：代码块里的 `$` 天然不被改写（与 lib/ai-citation 同一套做法）。
import type { Root } from "mdast";

/** 占位节点的类型名；不经 remark-math（未安装），改由 hName 落成 <span class="ai-math-*">，由渲染层识别 */
export const MATH_NODE_TYPE = "aiMath";

export const MATH_CLASS_INLINE = "ai-math-inline";
export const MATH_CLASS_BLOCK = "ai-math-block";

/**
 * 行内公式的形态防线：`$` 后紧跟空白或又一个 `$`、内容含换行、结束 `$` 前是空白、
 * 结束 `$` 后是数字，都不算公式。「$100 和 $200」这种最常见误伤靠最后一条挡掉。
 */
const INLINE_MATH_RE = /\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/g;

/** 块级公式：`$$…$$`，内容可跨行；先于行内规则跑，否则成对的 `$` 会被行内规则拆成半截 */
const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

/** 转换用的最小节点结构（与 ai-citation 一致：只依赖 type / value / children / data） */
export interface MathNode {
  type: string;
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  children?: MathNode[];
}

function mathNode(tex: string, display: boolean): MathNode {
  return {
    type: MATH_NODE_TYPE,
    data: { hName: "span", hProperties: { className: display ? MATH_CLASS_BLOCK : MATH_CLASS_INLINE } },
    children: [{ type: "text", value: tex }],
  };
}

/** 一段文本里的公式命中（按出现顺序）；内容为纯空白的不算 */
function mathHits(value: string, re: RegExp): { start: number; end: number; tex: string }[] {
  const out: { start: number; end: number; tex: string }[] = [];
  for (const m of value.matchAll(re)) {
    if (m[1].trim().length > 0) out.push({ start: m.index, end: m.index + m[0].length, tex: m[1] });
  }
  return out;
}

/**
 * 把一段文本按公式切开：先取 `$$…$$`（可以跨行），命中之后的各段剩余文本再按 `$…$` 取
 * （「$$a$$ 与 $b$ 同行」是模型常见写法）。整段没有公式时原样返回一个 text 节点。
 */
export function splitMath(value: string): MathNode[] {
  const out: MathNode[] = [];
  const pushInline = (text: string) => {
    const inline = mathHits(text, INLINE_MATH_RE);
    if (inline.length === 0) {
      out.push({ type: "text", value: text });
      return;
    }
    let cursor = 0;
    for (const h of inline) {
      if (h.start > cursor) out.push({ type: "text", value: text.slice(cursor, h.start) });
      out.push(mathNode(h.tex, false));
      cursor = h.end;
    }
    if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
  };

  const blocks = mathHits(value, BLOCK_MATH_RE);
  if (blocks.length === 0) {
    pushInline(value);
    return out;
  }
  let cursor = 0;
  for (const h of blocks) {
    if (h.start > cursor) pushInline(value.slice(cursor, h.start));
    out.push(mathNode(h.tex, true));
    cursor = h.end;
  }
  if (cursor < value.length) pushInline(value.slice(cursor));
  return out;
}

/** 就地改写一棵 mdast 子树 */
export function transformMath(node: MathNode): void {
  if (!node.children) return;
  const next: MathNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("$")) {
      next.push(...splitMath(child.value));
      continue;
    }
    transformMath(child);
    next.push(child);
  }
  node.children = next;
}

/** remark 插件：把答案里的 TeX 公式换成 KaTeX 占位节点 */
export function remarkAiMath() {
  return (tree: Root): void => {
    transformMath(tree);
  };
}
