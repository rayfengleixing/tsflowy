// AI 答案里的引用标记（`[id=<页面 id>]`）→ 可点跳转。
// 模型看到的检索结果每行都带 `[id=…]`（见 lib/ai-tools），它照抄进答案时原本只是一串死文本；
// 这里在 Markdown 的 text 节点上就地换成链接节点，代码块里的同样子串不受影响（只碰 text 节点）。
import type { Root } from "mdast";
import { appTree } from "@/lib/app-context";
import { findNode } from "@/lib/tree";
import { t } from "@/lib/i18n";

/**
 * 相对 URL 前缀（不能自定义协议：react-markdown 的默认 urlTransform 会剥掉未知协议，
 * `tsflowy:` 到不了点击处理）。相对形态原样保留，点击在 features/ai/Markdown.tsx 里拦截。
 */
export const CITATION_HREF_PREFIX = "tsflowy-citation/";

/** 引用里的页面 id 形态：与深链 row id 同一套脏值防线（答案出自模型，不能假定它干净） */
const CITED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 答案正文里的 `[id=…]` 标记；一次匹配一个，全局正则不复用（lastIndex 会跨调用串味） */
function citationMatches(value: string): { id: string; start: number; end: number }[] {
  const out: { id: string; start: number; end: number }[] = [];
  for (const m of value.matchAll(/\[id=([A-Za-z0-9_-]{1,64})\]/g)) {
    if (CITED_ID_RE.test(m[1])) out.push({ id: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function citationHref(viewId: string): string {
  return `${CITATION_HREF_PREFIX}${viewId}`;
}

/** 点击时从 href 还原页面 id；形态不对（手写链接、被截断的 href）返回 null，交给默认外链处理 */
export function citationViewId(href: string): string | null {
  if (!href.startsWith(CITATION_HREF_PREFIX)) return null;
  const id = href.slice(CITATION_HREF_PREFIX.length);
  return CITED_ID_RE.test(id) ? id : null;
}

/** 在页面树里解析引用标题；解析不到返回 null（宁可留原样文本，也不造一个点不动的假链接） */
export function resolveCitationTitle(viewId: string): string | null {
  if (!CITED_ID_RE.test(viewId)) return null;
  const node = findNode(appTree(), viewId);
  if (!node) return null;
  return node.name.trim() || t("common.untitled");
}

/** 转换用的最小节点结构：只依赖 type / value / children，代码节点的文本在 value 里、天然不被改写 */
export interface CitationNode {
  type: string;
  value?: string;
  url?: string;
  children?: CitationNode[];
}

/**
 * 把一段文本按 `[id=…]` 切开：命中的换成 link 节点（标题作链接文字），未命中的原样留作文本。
 * resolve 返回 null 表示「这页不存在或解析不了」，此时那一段完全不动。
 */
export function splitCitations(value: string, resolve: (viewId: string) => string | null): CitationNode[] {
  const matches = citationMatches(value);
  if (matches.length === 0) return [{ type: "text", value }];
  const out: CitationNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    const title = resolve(m.id);
    if (title === null) continue;
    if (m.start > cursor) out.push({ type: "text", value: value.slice(cursor, m.start) });
    out.push({ type: "link", url: citationHref(m.id), children: [{ type: "text", value: title }] });
    cursor = m.end;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

/** 就地改写一棵 mdast 子树；resolve 注入进来便于单测（生产用 resolveCitationTitle） */
export function transformCitations(node: CitationNode, resolve: (viewId: string) => string | null): void {
  if (!node.children) return;
  const next: CitationNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[id=")) {
      next.push(...splitCitations(child.value, resolve));
      continue;
    }
    transformCitations(child, resolve);
    next.push(child);
  }
  node.children = next;
}

/** remark 插件：把答案里的 `[id=…]` 变成指向该页的链接 */
export function remarkAiCitations() {
  return (tree: Root): void => {
    transformCitations(tree, resolveCitationTitle);
  };
}
