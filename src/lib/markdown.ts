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

// ——————————————————————————————————————
// jsonToMarkdown：TipTap JSON → Markdown 文本（Phase 4.1 导出体系）
//
// 设计原则：
//   - 纯函数，便于 Vitest 单测。
//   - 对 TipTap 原生块做精确映射；对高级块（columns/callout/toggle/math/gallery 等）
//     不追求无损 MD 往返，输出 HTML 注释 `<!-- unsupported block: X -->` 占位。
//   - mention 输出自定义语法 `@[label](view:<id>)`（导入时可解析回来或显示为纯文本）。
// ——————————————————————————————————————

const ESCAPE_MD_RE = /([`*_\[\]()#+\-!~\\>])/g;
function escapeInline(text: string): string {
  // 简单对特殊符号转义；不处理表格语法、避免过度转义破坏可读性。
  return text.replace(ESCAPE_MD_RE, "\\$1");
}

interface MarksRecord {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string | null;
  highlight?: boolean;
}

function marksOf(node: JSONContent): MarksRecord {
  const m: MarksRecord = {};
  if (!Array.isArray(node.marks)) return m;
  for (const mark of node.marks) {
    switch (mark.type) {
      case "bold": m.bold = true; break;
      case "italic": m.italic = true; break;
      case "strike": m.strike = true; break;
      case "code": m.code = true; break;
      case "link": m.link = (mark.attrs?.href as string) ?? null; break;
      case "highlight": m.highlight = true; break;
      // color/textStyle 等颜色不映射 Markdown，保留纯文本即可
    }
  }
  return m;
}

function wrapMarks(text: string, m: MarksRecord): string {
  if (m.code) {
    // code 优先级最高（外层不叠 bold/italic）
    return `\`${text}\``;
  }
  let out = text;
  if (m.bold) out = `**${out}**`;
  if (m.italic) out = `*${out}*`;
  if (m.strike) out = `~~${out}~~`;
  if (m.link) out = `[${out}](${m.link})`;
  // highlight：Markdown 无原生语法，用 ==包裹（Obsidian/Notion 兼容）
  if (m.highlight) out = `==${out}==`;
  return out;
}

function renderInline(nodes: JSONContent[] | undefined): string {
  if (!nodes || nodes.length === 0) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" && typeof n.text === "string") {
      const m = marksOf(n);
      // code mark 不转义内部内容
      const raw = m.code ? n.text : escapeInline(n.text);
      out += wrapMarks(raw, m);
    } else if (n.type === "hardBreak") {
      out += "\n";
    } else if (n.type === "mention") {
      const id = (n.attrs?.id as string) ?? "";
      const label = (n.attrs?.label as string) ?? id;
      out += `@[${label}](view:${id})`;
    } else if (n.type === "image") {
      const src = (n.attrs?.src as string) ?? "";
      const alt = (n.attrs?.alt as string) ?? "";
      out += `![${alt}](${src})`;
    } else if (n.type === "database-link") {
      const id = (n.attrs?.viewId as string) ?? "";
      const label = (n.attrs?.label as string) ?? id;
      out += `→[${label}](db:${id})`;
    } else {
      // 其他 inline（date/relations/hardBreak emoji 等）：回退到 textContent
      if (typeof n.text === "string") out += escapeInline(n.text);
      if (Array.isArray(n.content)) out += renderInline(n.content);
    }
  }
  return out;
}

function indentLines(text: string, indent: string): string {
  return text.split("\n").map((l) => (l === "" ? "" : indent + l)).join("\n");
}

function renderBlock(node: JSONContent, ctx: { orderedIndex?: number; indent: string } = { indent: "" }): string {
  const indent = ctx.indent;
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);

    case "heading": {
      const level = Math.max(1, Math.min(6, (node.attrs?.level as number) ?? 1));
      const hashes = "#".repeat(level);
      return `${hashes} ${renderInline(node.content)}`;
    }

    case "horizontalRule":
      return "---";

    case "blockquote": {
      const inner = renderChildren(node.content, "");
      return indentLines(inner, "> ").replace(/^> $/gm, ">");
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = node.content?.map((c) => c.text ?? "").join("") ?? "";
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "callout": {
      const emoji = (node.attrs?.emoji as string) ?? "💡";
      const inner = renderChildren(node.content, "");
      const lines = inner.split("\n");
      return `> ${emoji} **Callout**\n> ${lines.join("\n> ")}`;
    }

    case "toggle": {
      const checked = node.attrs?.checked ? "x" : " ";
      const title = (node.attrs?.title as string) ?? "";
      const inner = renderChildren(node.content, "  ");
      return `> <details><summary>[${checked}] ${escapeInline(title)}</summary>\n> \n${inner}\n> \n> </details>`;
    }

    case "bulletList":
    case "taskList":
    case "orderedList": {
      const items = node.content ?? [];
      return items
        .map((it, i) => renderListItem(it, i, node.type === "orderedList", indent))
        .join("\n");
    }

    case "table": {
      // TipTap table: content = tableRow (header then body)
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) => renderInline(cell.content)),
      );
      if (rows.length === 0) return "";
      const header = rows[0];
      const body = rows.slice(1);
      const sep = `| ${header.map(() => "---").join(" | ")} |`;
      const renderRow = (r: string[]) => `| ${r.join(" | ")} |`;
      const out = [renderRow(header), sep, ...body.map(renderRow)];
      return out.join("\n");
    }

    case "image": {
      const src = (node.attrs?.src as string) ?? "";
      const alt = (node.attrs?.alt as string) ?? "";
      return `![${alt}](${src})`;
    }

    case "math": {
      const expr = (node.attrs?.expr as string) ?? "";
      const display = node.attrs?.display ? "$$" : "$";
      return `${display}${expr}${display}`;
    }

    case "database-view": {
      const viewId = (node.attrs?.viewId as string) ?? "";
      return `<!-- database view: ${viewId} -->`;
    }

    case "columns": {
      const count = (node.content ?? []).length;
      const parts = (node.content ?? []).map((col, i) => {
        const inner = renderChildren(col.content, "    ");
        return `  <!-- column ${i + 1}/${count} -->\n${inner}`;
      });
      return `<!-- columns (${count}) -->\n${parts.join("\n")}`;
    }

    case "image-gallery": {
      const urls: string[] = (node.attrs?.urls as string[]) ?? [];
      return `<!-- image gallery (${urls.length} images) -->\n${urls.map((u) => `![]( ${u} )`).join("\n")}`;
    }

    case "outline":
      return "<!-- outline block -->";

    case "attachment": {
      const name = (node.attrs?.name as string) ?? "";
      const url = (node.attrs?.url as string) ?? "";
      return `[${name}](${url})`;
    }

    // 兜底：未知类型 → HTML 注释占位，避免导出时丢失结构
    default:
      if (Array.isArray(node.content) && node.content.length > 0) {
        return `<!-- unsupported block: ${node.type} -->\n${renderChildren(node.content, indent)}`;
      }
      return `<!-- unsupported block: ${node.type} -->`;
  }
}

function renderListItem(item: JSONContent, index: number, ordered: boolean, indent: string): string {
  // item.type 预期：listItem 或 taskItem
  const prefix = ordered ? `${index + 1}. ` : "- ";
  const check = item.type === "taskItem" ? (item.attrs?.checked ? "[x] " : "[ ] ") : "";
  // item.content = [paragraph, ?nestedList, ...]
  const contents = item.content ?? [];
  const firstPara = contents.find((c) => c.type === "paragraph");
  const nested = contents.find((c) =>
    c.type === "bulletList" || c.type === "orderedList" || c.type === "taskList",
  );
  const head = indent + prefix + check + renderInline(firstPara?.content);
  if (!nested) return head;
  const tail = renderBlock(nested, { indent: indent + "  " });
  return `${head}\n${tail}`;
}

function renderChildren(children: JSONContent[] | undefined, indent: string): string {
  if (!children || children.length === 0) return "";
  // 如果所有子节点都是"内联级"（text/mention/image/database-link 等，非块类型），
  // 直接拼接内联渲染结果；避免 markdownToJson 生成的 blockquote.content: [{type:'text',...}] 被当作未知块。
  const allInline = children.every(
    (n) =>
      n.type === "text" ||
      n.type === "mention" ||
      n.type === "image" ||
      n.type === "database-link" ||
      n.type === "hardBreak",
  );
  if (allInline) return indent + renderInline(children);
  const parts: string[] = [];
  for (const c of children) parts.push(renderBlock(c, { indent }));
  // 两个块间空行分隔（heading 后需要，列表项内部由 renderListItem 负责）
  return parts.join("\n\n");
}

/**
 * TipTap doc JSON → Markdown 文本（Phase 4.1）。
 *
 * 支持：paragraph / heading / horizontalRule / blockquote / codeBlock /
 *       bulletList / orderedList / taskList / table / image / mention / math / attachment；
 * 高级块（callout/toggle/columns/database-view/gallery/outline）输出可读占位注释，
 * 不保证与 markdownToJson 严格往返对称，但内容可读不丢失。
 */
export function jsonToMarkdown(json: JSONContent): string {
  const root = json.type === "doc" ? json : { type: "doc", content: [json] };
  return renderChildren(root.content, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}