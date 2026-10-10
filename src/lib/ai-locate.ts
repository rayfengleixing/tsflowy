// AI 跨页/定位编辑的 JSON 层实现：当 apply_edit 目标不是当前打开的编辑器时，
// 直接对库中 TipTap JSON 做定位改写并整篇保存（documentApi.save 会一并重建 mentions）。
// 与编辑器内实现（EditorPage 的 applyEdit）共用同一套锚点语义：heading 定位小节、text 定位原文。

import type { JSONContent } from "@tiptap/core";
import type { AiEditAnchor, AiEditOp } from "./ai-edit";
import { looksLikeMarkdown, markdownToJson, parseInline, textToBlocks } from "./markdown";

/** 归一化为 doc 根节点（库中可能存在块数组形态的历史数据） */
export function asDoc(raw: JSONContent | JSONContent[]): JSONContent {
  return Array.isArray(raw) ? { type: "doc", content: raw } : raw;
}

/** 把 Markdown/纯文本转成块节点数组（与编辑器回填 toSlice 同一套转换） */
export function markdownToNodes(markdown: string): JSONContent[] {
  const json = looksLikeMarkdown(markdown) ? markdownToJson(markdown) : textToBlocks(markdown);
  return json.content ?? [];
}

/** heading 匹配：忽略前导 #、加粗符号与空白差异（"## 背景" ≈ "背景" ≈ "**背景**"） */
export function headingMatches(nodeText: string, wanted: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/^[#*\s]+/, "")
      .replace(/[*\s]+$/, "")
      .trim();
  const a = norm(nodeText);
  const b = norm(wanted);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

interface Section {
  /** 标题节点下标 */
  headingIndex: number;
  /** 小节内容 [start, end)：标题之后、下一个同级或更高标题之前 */
  start: number;
  end: number;
}

function findSection(content: JSONContent[], heading: string): Section | null {
  for (let i = 0; i < content.length; i++) {
    const n = content[i];
    if (n.type === "heading" && headingMatches(textOfNode(n), heading)) {
      const level = Number((n.attrs as { level?: number } | undefined)?.level ?? 1);
      let end = content.length;
      for (let j = i + 1; j < content.length; j++) {
        const c = content[j];
        if (c.type === "heading" && Number((c.attrs as { level?: number } | undefined)?.level ?? 1) <= level) {
          end = j;
          break;
        }
      }
      return { headingIndex: i, start: i + 1, end };
    }
  }
  return null;
}

/** 节点的纯文本（递归取 text 节点） */
export function textOfNode(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (!node.content) return "";
  return node.content.map(textOfNode).join("");
}

/**
 * 在文档 content 中定位 anchor.text：只在单个块内匹配（跨块替换语义不清，宁可失败）。
 */
function findTextBlock(content: JSONContent[], wanted: string): number {
  for (let i = 0; i < content.length; i++) {
    if (textOfNode(content[i]).includes(wanted)) return i;
  }
  return -1;
}

/** 把命中块的内联内容里的一段文字换成 Markdown 内联节点（块内替换，保留其余内联标记会退化为纯文本） */
function replaceTextInNode(node: JSONContent, wanted: string, markdown: string): JSONContent | null {
  const content = node.content ?? [];
  // 依次尝试每个 text 子节点内的命中
  for (let i = 0; i < content.length; i++) {
    const child = content[i];
    if (child.type !== "text" || !child.text) continue;
    const off = child.text.indexOf(wanted);
    if (off === -1) continue;
    const inlines = parseInline(markdown);
    const next = [
      ...content.slice(0, i),
      ...(child.text.slice(0, off) ? [{ type: "text", text: child.text.slice(0, off) }] : []),
      ...inlines,
      ...(child.text.slice(off + wanted.length) ? [{ type: "text", text: child.text.slice(off + wanted.length) }] : []),
      ...content.slice(i + 1),
    ];
    return { ...node, content: next };
  }
  return null;
}

export interface LocateFailure {
  ok: false;
  reason: "no_doc" | "heading_not_found" | "text_not_found" | "protected_heading" | "bad_structure";
}

export interface LocateSuccess {
  ok: true;
  content: JSONContent[];
  /** diff 预览用的被替换原文 */
  before: string;
}

export type LocateResult = LocateFailure | LocateSuccess;

const fail = (reason: LocateFailure["reason"]): LocateFailure => ({ ok: false, reason });

/**
 * 对整篇 doc JSON 应用一次定位编辑，返回改后的 content 数组。
 * 仅用于「目标不是当前编辑器」或「定位类 op」的兜底路径；
 * 当前页面内的编辑优先走编辑器事务（可撤销、有结构锁定保护）。
 */
export function applyEditToDocJson(
  doc: JSONContent,
  op: AiEditOp,
  markdown: string,
  anchor?: AiEditAnchor,
): LocateResult {
  const content = doc.content;
  if (!Array.isArray(content)) return fail("bad_structure");
  const nodes = markdownToNodes(markdown);
  switch (op) {
    case "append_to_document":
      return { ok: true, content: [...content, ...nodes], before: "" };
    case "insert_under_heading": {
      if (!anchor?.heading) return fail("heading_not_found");
      const sec = findSection(content, anchor.heading);
      if (!sec) return fail("heading_not_found");
      const next = [...content];
      next.splice(sec.end, 0, ...nodes);
      return { ok: true, content: next, before: "" };
    }
    case "replace_under_heading": {
      if (!anchor?.heading) return fail("heading_not_found");
      const sec = findSection(content, anchor.heading);
      if (!sec) return fail("heading_not_found");
      if (sec.headingIndex === 0) return fail("protected_heading");
      const removed = content.slice(sec.start, sec.end);
      const next = [...content];
      next.splice(sec.start, sec.end - sec.start, ...nodes);
      return { ok: true, content: next, before: removed.map(textOfNode).join("\n") };
    }
    case "replace_text": {
      if (!anchor?.text) return fail("text_not_found");
      const hit = findTextBlock(content, anchor.text);
      if (hit === -1) return fail("text_not_found");
      // H1 标题由 view.name 权威管理，JSON 路径同样不碰
      if (hit === 0 && content[0]?.type === "heading") return fail("protected_heading");
      const replaced = replaceTextInNode(content[hit], anchor.text, markdown);
      if (!replaced) return fail("bad_structure");
      const next = [...content];
      next[hit] = replaced;
      return { ok: true, content: next, before: anchor.text };
    }
    default:
      // 选区/光标类 op 依赖编辑器状态，JSON 路径无法定位
      return fail("bad_structure");
  }
}
