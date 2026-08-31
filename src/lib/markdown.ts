import type { JSONContent } from "@tiptap/core";

// Markdown 粘贴转换（项目说明书 8.2/10-M3：粘贴 markdown 文本自动转成块）。
// 纯函数：文本 → TipTap JSON，便于 Vitest 单测。

/** 行内语法：加粗/斜体/行内代码/删除线/图片/链接 */
const INLINE_RE =
  /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)|(~~[^~\n]+~~)|(!\[[^\]]*\]\([^)\n]+\))|(\[[^\]]+\]\([^)\n]+\))/g;

const CODE_FENCE_RE = /^```(\w*)\s*$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const TASK_RE = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;

function textWithMarks(text: string, marks: JSONContent["marks"] = []): JSONContent {
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

/** 行内解析：普通文本 + 粗/斜/删/码/链接/图片 */
export function parseInline(text: string): JSONContent[] {
  const out: JSONContent[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(textWithMarks(text.slice(last, m.index)));
    last = m.index + m[0].length;
    const raw = m[0];
    if (raw.startsWith("**")) {
      out.push(textWithMarks(raw.slice(2, -2), [{ type: "bold" }]));
    } else if (raw.startsWith("~~")) {
      out.push(textWithMarks(raw.slice(2, -2), [{ type: "strike" }]));
    } else if (raw.startsWith("`")) {
      out.push(textWithMarks(raw.slice(1, -1), [{ type: "code" }]));
    } else if (raw.startsWith("!")) {
      const inner = raw.slice(2, -1); // [alt](src)
      const close = inner.indexOf("](");
      out.push({
        type: "image",
        attrs: { src: inner.slice(close + 2), alt: inner.slice(0, close) },
      });
    } else if (raw.startsWith("[")) {
      const inner = raw.slice(1, -1);
      const close = inner.indexOf("](");
      const label = inner.slice(0, close);
      const href = inner.slice(close + 2);
      out.push(textWithMarks(label, [{ type: "link", attrs: { href } }]));
    } else if (raw.startsWith("*")) {
      out.push(textWithMarks(raw.slice(1, -1), [{ type: "italic" }]));
    } else {
      out.push(textWithMarks(raw));
    }
  }
  if (last < text.length) out.push(textWithMarks(text.slice(last)));
  return out;
}

/** 判断文本是否含 markdown 结构（粘贴时决定走 markdown 转换还是纯文本分行） */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.some((line) => {
    const l = line.trim();
    return (
      /^(#{1,3})\s+/.test(l) ||
      /^[-*+]\s+\[[ xX]\]/.test(l) ||
      /^[-*+]\s+/.test(l) ||
      /^\d+[.)]\s+/.test(l) ||
      /^>\s?/.test(l) ||
      /^```/.test(l) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(l)
    );
  });
}

/** 纯文本按行拆成多个段落（保留换行粘贴语义，避免合并成一行） */
export function textToBlocks(text: string): JSONContent {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return { type: "doc", content: lines.map((line) => ({ type: "paragraph", content: parseInline(line) })) };
}

/** Markdown 文本 → TipTap doc JSON（覆盖 M3 基础块：标题/列表/任务/引用/代码/分割线/图片/表格行外） */
export function markdownToJson(md: string): JSONContent {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // 代码围栏
    const fence = CODE_FENCE_RE.exec(trimmed);
    if (fence) {
      const lang = fence[1] || null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合围栏
      blocks.push({
        type: "codeBlock",
        ...(lang ? { attrs: { language: lang } } : {}),
        content: [{ type: "text", text: buf.join("\n") }],
      });
      continue;
    }

    // 标题 1-3
    const h = HEADING_RE.exec(trimmed);
    if (h) {
      blocks.push({
        type: "heading",
        attrs: { level: h[1].length },
        content: parseInline(h[2]),
      });
      i++;
      continue;
    }

    // 分割线
    if (HR_RE.test(trimmed)) {
      blocks.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // 引用（单层）
    if (trimmed.startsWith(">")) {
      blocks.push({ type: "blockquote", content: parseInline(trimmed.replace(/^>\s?/, "")) });
      i++;
      continue;
    }

    // 待办列表
    const task = TASK_RE.exec(trimmed);
    if (task) {
      const items: JSONContent[] = [];
      while (i < lines.length) {
        const m = TASK_RE.exec(lines[i].trim());
        if (!m) break;
        items.push({
          type: "taskItem",
          attrs: { checked: m[1].toLowerCase() === "x" },
          content: [{ type: "paragraph", content: parseInline(m[2]) }],
        });
        i++;
      }
      blocks.push({ type: "taskList", content: items });
      continue;
    }

    // 无序列表
    const bullet = BULLET_RE.exec(trimmed);
    if (bullet) {
      const items: JSONContent[] = [];
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i].trim());
        if (!m) break;
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(m[1]) }] });
        i++;
      }
      blocks.push({ type: "bulletList", content: items });
      continue;
    }

    // 有序列表
    const ordered = ORDERED_RE.exec(trimmed);
    if (ordered) {
      const items: JSONContent[] = [];
      while (i < lines.length) {
        const m = ORDERED_RE.exec(lines[i].trim());
        if (!m) break;
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(m[1]) }] });
        i++;
      }
      blocks.push({ type: "orderedList", content: items });
      continue;
    }

    // 普通段落：连续非空行合并
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      buf.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", content: parseInline(buf.join(" ")) });
  }

  return { type: "doc", content: blocks };
}