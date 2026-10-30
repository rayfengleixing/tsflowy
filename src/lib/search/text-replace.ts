// 跨页/全局替换的 JSON 层改写（候选页由 Rust 的 doc_ids_matching 圈定，见 commands/db.rs）。
//
// 语义边界，和文档内 Ctrl+F（features/editor/extensions/find-replace.ts）刻意不同：
//   - 这里只在单个 text 叶子内做字面替换，mark / 节点结构一律原样保留；
//     Ctrl+F 走拼接索引，能命中跨 mark、跨块的字符串，但那要把内联内容重排，
//     批量跑在整库页面上风险远大于收益，所以本页改不动的命中会如实回报（crossFormat），
//     由 UI 提示用户回页面内用 Ctrl+F 处理，绝不静默跳过。
//   - 首个标题块是页面标题（由 views.name 权威管理，前端也锁死不让改），计数后跳过。
//   - atom 节点的属性文本（mention 的 label、math/mermaid 源码、附件名）不是 text 叶子，不参与替换。
import type { JSONContent } from "@tiptap/core";

import { textOfNode } from "../ai/ai-locate";

export interface ReplaceOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/** 一次文档改写的三类计数；crossFormat/protectedTitle 是「看到了但没改」，UI 必须区分展示 */
export interface ReplaceCounts {
  replaced: number;
  crossFormat: number;
  protectedTitle: number;
}

/**
 * 「词字符」口径与 Ctrl+F 保持一致：拉丁字母（含常见带变音的扩展区）、数字、下划线。
 * 中日韩不使用词间空格，因此全词对纯中文查询等价于不限制。
 */
const WORD_CHAR = /[A-Za-z0-9_\u00C0-\u00FF\u0100-\u024F\u1E00-\u1EFF]/;

function isWholeWordAt(text: string, idx: number, len: number): boolean {
  const before = idx > 0 ? text[idx - 1] : "";
  const after = text[idx + len] ?? "";
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after));
}

/** 长度不变的小写化；İ→i̇ 这类会变长的语言陷阱直接退回原文，保证下标可用 */
function lowerSafe(input: string): string {
  const lower = input.toLowerCase();
  return lower.length === input.length ? lower : input;
}

/** 在一个字符串里做字面全替换；needle 为空一律原样返回（防止「在每个位置插入」） */
export function replaceOccurrences(
  text: string,
  needle: string,
  replacement: string,
  options: ReplaceOptions = {},
): { text: string; count: number } {
  if (!text || !needle) return { text, count: 0 };
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;
  const hay = caseSensitive ? text : lowerSafe(text);
  const nee = caseSensitive ? needle : lowerSafe(needle);
  const out: string[] = [];
  let count = 0;
  let cursor = 0;
  let idx = hay.indexOf(nee);
  while (idx !== -1) {
    if (wholeWord && !isWholeWordAt(text, idx, nee.length)) {
      idx = hay.indexOf(nee, idx + 1);
      continue;
    }
    out.push(text.slice(cursor, idx), replacement);
    cursor = idx + nee.length;
    count++;
    idx = hay.indexOf(nee, cursor);
  }
  if (count === 0) return { text, count: 0 };
  out.push(text.slice(cursor));
  return { text: out.join(""), count };
}

/** 只计数不改写：复用替换本身，保证「预览说有几处」和「执行改了几处」永远同一套语义 */
function countInText(text: string, needle: string, options: ReplaceOptions): number {
  return replaceOccurrences(text, needle, text, options).count;
}

/** 改写结果里的 null 表示该 text 叶子被替换成了空串——ProseMirror 不允许空 text 节点 */
function replaceInNode(
  node: JSONContent,
  needle: string,
  replacement: string,
  options: ReplaceOptions,
): { node: JSONContent | null; count: number } {
  if (node.type === "text") {
    if (typeof node.text !== "string") return { node, count: 0 };
    const replaced = replaceOccurrences(node.text, needle, replacement, options);
    if (replaced.count === 0) return { node, count: 0 };
    if (replaced.text === "") return { node: null, count: replaced.count };
    return { node: { ...node, text: replaced.text }, count: replaced.count };
  }
  const children = node.content;
  if (!Array.isArray(children) || children.length === 0) return { node, count: 0 };
  const mapped = children.map((child) => replaceInNode(child, needle, replacement, options));
  let count = 0;
  for (const m of mapped) count += m.count;
  if (count === 0) return { node, count: 0 };
  const next = mapped.map((m) => m.node).filter((n): n is JSONContent => n !== null);
  const { content: _content, ...rest } = node;
  return { node: next.length > 0 ? { ...rest, content: next } : rest, count };
}

export interface DocContentReplaceResult {
  content: JSONContent[];
  counts: ReplaceCounts;
}

const NO_CHANGES = (content: JSONContent[]): DocContentReplaceResult => ({
  content,
  counts: { replaced: 0, crossFormat: 0, protectedTitle: 0 },
});

/**
 * 对一篇文档的顶层块数组做全局替换，返回新数组与三类计数。
 * 顶层块逐个处理：不跨越块边界，因此结构（列表层级、表格、分栏）不可能被改坏。
 */
export function replaceInDocContent(
  content: JSONContent[],
  needle: string,
  replacement: string,
  options: ReplaceOptions = {},
): DocContentReplaceResult {
  if (!needle || content.length === 0) return NO_CHANGES(content);
  const counts: ReplaceCounts = { replaced: 0, crossFormat: 0, protectedTitle: 0 };
  const next: JSONContent[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    // 按整块拼出的纯文本计数：跨内联段的命中也算「看到了」，快路径与跨格式判定用同一个数
    const inBlock = countInText(textOfNode(block), needle, options);
    if (inBlock === 0) {
      next.push(block);
      continue;
    }
    // 首块是标题 = 页面标题（views.name 的镜像），改了会和标题不同步
    if (i === 0 && block.type === "heading") {
      counts.protectedTitle += inBlock;
      next.push(block);
      continue;
    }
    const replaced = replaceInNode(block, needle, replacement, options);
    counts.replaced += replaced.count;
    // 块内文本里出现、但叶子层一次都没落到 = 命中横跨了内联段
    counts.crossFormat += inBlock - replaced.count;
    next.push(replaced.node ?? block);
  }
  return { content: next, counts };
}
