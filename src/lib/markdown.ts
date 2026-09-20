import type { JSONContent } from "@tiptap/core";

// Markdown 粘贴转换（项目说明书 8.2/10-M3：粘贴 markdown 文本自动转成块）。
// 纯函数：文本 → TipTap JSON，便于 Vitest 单测。

/** 行内语法：mention/数据库链接/加粗/斜体/行内代码/删除线/高亮/图片/链接 */
const INLINE_RE =
  /(@\[[^\]]*\]\(view:[^)\n]+\))|(→\[[^\]]*\]\(db:[^)\n]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)|(~~[^~\n]+~~)|(==[^=\n]+==)|(!\[[^\]]*\]\([^)\n]+\))|(\[[^\]]+\]\([^)\n]+\))/g;

// 导出时 escapeInline 会给特殊符号加反斜杠；导入解析前先把 `\X` 换成私用区占位符，
// 否则 `\*literal\*` 会被当成斜体匹配，解析完再还原（正文不会出现私用区字符）。
const ESCAPE_CHARS = "`*_[]()#+-!~\\>=";
const ESCAPE_PLACEHOLDER = 0xe000;

function protectEscapes(text: string): string {
  return text.replace(/\\([`*_[\]()#+\-!~\\>=])/g, (_m, ch: string) =>
    String.fromCharCode(ESCAPE_PLACEHOLDER + ESCAPE_CHARS.indexOf(ch)),
  );
}

function restoreEscapes(text: string): string {
  const last = ESCAPE_PLACEHOLDER + ESCAPE_CHARS.length - 1;
  return text.replace(new RegExp(`[\\u${ESCAPE_PLACEHOLDER.toString(16)}-\\u${last.toString(16)}]`, "g"), (ch) => {
    const idx = ch.charCodeAt(0) - ESCAPE_PLACEHOLDER;
    return ESCAPE_CHARS[idx] ?? ch;
  });
}

const CODE_FENCE_RE = /^```(\w*)\s*$/;
const MERMAID_FENCE_RE = /^```mermaid\s*$/i;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const TASK_RE = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;
const MATH_FENCE_RE = /^\$\$\s*$/;
const MATH_ONE_LINE_RE = /^\$\$(.+)\$\$$/;
const DETAILS_RE = /^<details\b[^>]*>$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;
const SUMMARY_RE = /^<summary>(.*)<\/summary>$/i;
const TABLE_ROW_RE = /^\|.*\|$/;
const TABLE_SEP_RE = /^\|[\s:|-]+\|$/;
const COLUMNS_RE = /^<!--\s*columns\s*\((\d+)\)\s*-->$/;
const COLUMN_RE = /^<!--\s*column\s+(\d+)\s*\/\s*(\d+)\s*-->$/;
const COLUMNS_END_RE = /^<!--\s*\/columns\s*-->$/;
const DB_VIEW_RE = /^→\[([^\]]*)\]\(db:([^)\n]+)\)$/;
/** 附件导出格式 `[name](attach:src)` 的协议前缀 */
const ATTACH_PREFIX = "attach:";

function textWithMarks(text: string, marks: JSONContent["marks"] = []): JSONContent {
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

/** 行内解析：mention/数据库链接/普通文本 + 粗/斜/删/高亮/码/链接/图片 */
export function parseInline(text: string): JSONContent[] {
  const out: JSONContent[] = [];
  const source = protectEscapes(text);
  const push = (value: string, marks: JSONContent["marks"] = []) => {
    if (value === "") return;
    out.push(textWithMarks(restoreEscapes(value), marks));
  };
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(source)) !== null) {
    if (m.index > last) push(source.slice(last, m.index));
    last = m.index + m[0].length;
    const raw = m[0];
    if (raw.startsWith("@[")) {
      // mention 导出格式 @[label](view:id)；id 为空则按普通文本处理（无法还原成 mention）
      const mm = /^@\[([^\]]*)\]\(view:([^)\n]+)\)$/.exec(raw);
      if (mm?.[2]) out.push({ type: "mention", attrs: { id: mm[2], label: mm[1] } });
      else push(raw);
    } else if (raw.startsWith("→[")) {
      // 数据库视图引用（导出格式 →[label](db:viewId)）：行内出现时按纯文本保留，
      // 独占一段的由 markdownToJson 直接还原成 databaseView 块
      push(raw);
    } else if (raw.startsWith("**")) {
      push(raw.slice(2, -2), [{ type: "bold" }]);
    } else if (raw.startsWith("~~")) {
      push(raw.slice(2, -2), [{ type: "strike" }]);
    } else if (raw.startsWith("==")) {
      push(raw.slice(2, -2), [{ type: "highlight" }]);
    } else if (raw.startsWith("`")) {
      // 行内代码内容不做转义还原（导出时也不转义）
      out.push(textWithMarks(raw.slice(1, -1), [{ type: "code" }]));
    } else if (raw.startsWith("!")) {
      const inner = raw.slice(2, -1); // [alt](src)
      const close = inner.indexOf("](");
      const src = inner.slice(close + 2);
      // 尾缀 {width=60%}：图片显示宽度（导出时 width≠100 才带）
      const wm = /\{width=(\d+)%\}$/.exec(src);
      const attrs: Record<string, unknown> = { src: wm ? src.slice(0, wm.index) : src, alt: inner.slice(0, close) };
      if (wm) attrs.width = Math.max(20, Math.min(100, Number(wm[1])));
      out.push({ type: "image", attrs });
    } else if (raw.startsWith("[")) {
      const inner = raw.slice(1, -1);
      const close = inner.indexOf("](");
      const label = inner.slice(0, close);
      const href = inner.slice(close + 2);
      push(label, [{ type: "link", attrs: { href } }]);
    } else if (raw.startsWith("*")) {
      push(raw.slice(1, -1), [{ type: "italic" }]);
    } else {
      push(raw);
    }
  }
  if (last < source.length) push(source.slice(last));
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
      l.startsWith("```") ||
      l.startsWith("$$") ||
      /^<details\b/i.test(l) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(l)
    );
  });
}

/** 纯文本按行拆成多个段落（保留换行粘贴语义，避免合并成一行） */
export function textToBlocks(text: string): JSONContent {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return { type: "doc", content: lines.map((line) => ({ type: "paragraph", content: parseInline(line) })) };
}

/** Markdown 文本 → TipTap doc JSON（M3 基础块 + math $$ 围栏 + toggle <details>，嵌套 details 递归解析） */
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

    // mermaid 围栏：```mermaid（在通用代码围栏前判断，否则会被当作 codeBlock）
    if (MERMAID_FENCE_RE.test(trimmed)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合围栏
      blocks.push({ type: "mermaid", attrs: { code: buf.join("\n") } });
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

    // display math：$$ 围栏（jsonToMarkdown 的导出格式为 $$\n{tex}\n$$）
    if (MATH_FENCE_RE.test(trimmed)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !MATH_FENCE_RE.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 $$（未闭合则消费到结尾）
      blocks.push({ type: "math", attrs: { tex: buf.join("\n").trim() } });
      continue;
    }

    // 单行 $$...$$ 的块级公式
    const mathOne = MATH_ONE_LINE_RE.exec(trimmed);
    if (mathOne) {
      blocks.push({ type: "math", attrs: { tex: mathOne[1] } });
      i++;
      continue;
    }

    // toggle：<details> HTML（jsonToMarkdown 的导出格式），<summary> 为标题块；
    // 嵌套 details 用深度计数匹配闭合标签
    if (DETAILS_RE.test(trimmed)) {
      const isOpen = /\sopen\b/i.test(trimmed);
      let depth = 1;
      const innerLines: string[] = [];
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (DETAILS_RE.test(t)) {
          depth++;
        } else if (DETAILS_CLOSE_RE.test(t)) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        innerLines.push(lines[i]);
        i++;
      }
      blocks.push(detailsToToggle(innerLines, isOpen));
      continue;
    }

    // 分栏：<!-- columns (n) --> … <!-- column i/n --> … <!-- /columns -->（jsonToMarkdown 的导出格式）
    if (COLUMNS_RE.test(trimmed)) {
      i++;
      const cols: JSONContent[] = [];
      let cur: string[] = [];
      let collecting = false;
      while (i < lines.length && !COLUMNS_END_RE.test(lines[i].trim())) {
        if (COLUMN_RE.test(lines[i].trim())) {
          if (collecting) cols.push(columnToJson(cur));
          cur = [];
          collecting = true;
          i++;
          continue;
        }
        cur.push(lines[i]);
        i++;
      }
      i++; // 跳过 <!-- /columns -->
      if (collecting) cols.push(columnToJson(cur));
      blocks.push({
        type: "columns",
        content: cols.length > 0 ? cols : [{ type: "column", content: [{ type: "paragraph" }] }],
      });
      continue;
    }

    // 数据库视图：→[name](db:viewId)（jsonToMarkdown 的导出格式）
    const dbView = DB_VIEW_RE.exec(trimmed);
    if (dbView) {
      blocks.push({ type: "databaseView", attrs: { viewId: dbView[2], name: dbView[1] } });
      i++;
      continue;
    }

    // 表格：| a | b | 表头行 + |---|---| 分隔行（jsonToMarkdown 的导出格式）
    if (TABLE_ROW_RE.test(trimmed) && TABLE_SEP_RE.test(lines[i + 1]?.trim() ?? "")) {
      const rows: string[][] = [splitTableRow(trimmed)];
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i].trim())) {
        rows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      blocks.push(tableToJson(rows));
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
    const inline = parseInline(buf.join(" "));
    // 独占一段的 attachment 还原为块级节点（导出时它在块级位置）
    const soloLink = inline.length === 1 ? inline[0] : undefined;
    if (soloLink?.type === "text" && soloLink.marks?.length === 1) {
      const mark = soloLink.marks[0];
      const href = String(mark.attrs?.href ?? "");
      if (mark.type === "link" && href.startsWith(ATTACH_PREFIX)) {
        blocks.push({
          type: "attachment",
          attrs: { src: href.slice(ATTACH_PREFIX.length), name: soloLink.text ?? "" },
        });
        continue;
      }
    }
    blocks.push({ type: "paragraph", content: inline });
  }

  return { type: "doc", content: blocks };
}

/** 表格行 `| a | b |` → 单元格文本数组 */
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** 单元格文本 → 单元格内容：导出时单元格内多块用 <br> 连接，导回时还原为 hardBreak */
function cellContent(text: string): JSONContent[] {
  const inline: JSONContent[] = [];
  text.split(/<br\s*\/?>/i).forEach((part, idx) => {
    if (idx > 0) inline.push({ type: "hardBreak" });
    inline.push(...parseInline(part));
  });
  return [{ type: "paragraph", content: inline }];
}

function tableToJson(rows: string[][]): JSONContent {
  if (rows.length === 0) return { type: "table", content: [] };
  const [header, ...body] = rows;
  const makeRow = (cells: string[], type: "tableHeader" | "tableCell"): JSONContent => ({
    type: "tableRow",
    content: cells.map((c) => ({ type, content: cellContent(c) })),
  });
  return { type: "table", content: [makeRow(header, "tableHeader"), ...body.map((r) => makeRow(r, "tableCell"))] };
}

/** 分栏内容行 → column 节点（递归走 markdownToJson，空列补空段落） */
function columnToJson(lines: string[]): JSONContent {
  const inner = markdownToJson(lines.join("\n")).content ?? [];
  return { type: "column", content: inner.length > 0 ? inner : [{ type: "paragraph" }] };
}

/** <details> 内部行 → toggle 节点：<summary> 还原为标题段落，其余递归走 markdownToJson */
function detailsToToggle(innerLines: string[], isOpen: boolean): JSONContent {
  const content: JSONContent[] = [];
  let start = 0;
  while (start < innerLines.length && innerLines[start].trim() === "") start++;
  const summary = SUMMARY_RE.exec(innerLines[start]?.trim() ?? "");
  if (summary) {
    // 导出时标题做了 HTML 转义（& < 等），导入时先解码再走行内解析
    content.push({ type: "paragraph", content: parseInline(decodeHtmlEntities(summary[1])) });
    start++;
  }
  const innerJson = markdownToJson(innerLines.slice(start).join("\n").trim());
  content.push(...(innerJson.content ?? []));
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "toggle", attrs: { collapsed: !isOpen }, content };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// ——————————————————————————————————————
// jsonToMarkdown：TipTap JSON → Markdown 文本（Phase 4.1 导出体系）
//
// 设计原则：
//   - 纯函数，便于 Vitest 单测。
//   - 对 TipTap 原生块做精确映射；可往返块（table/columns/toggle/math/mermaid/databaseView/attachment）
//     的导出格式与 markdownToJson 的解析一一对应；callout/gallery/outline 输出占位注释。
//   - mention 输出自定义语法 `@[label](view:<id>)`，数据库视图块（databaseView）输出 `→[label](db:<id>)`（可导入还原）。
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
      case "bold":
        m.bold = true;
        break;
      case "italic":
        m.italic = true;
        break;
      case "strike":
        m.strike = true;
        break;
      case "code":
        m.code = true;
        break;
      case "link":
        m.link = (mark.attrs?.href as string) ?? null;
        break;
      case "highlight":
        m.highlight = true;
        break;
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
      const w = (n.attrs?.width as number | undefined) ?? 100;
      out += `![${alt}](${src}${w !== 100 ? `{width=${w}%}` : ""})`;
    } else {
      // 其他 inline（date/relations/hardBreak emoji 等）：回退到 textContent
      if (typeof n.text === "string") out += escapeInline(n.text);
      if (Array.isArray(n.content)) out += renderInline(n.content);
    }
  }
  return out;
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? "" : indent + l))
    .join("\n");
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
      // toggle 唯一属性是 collapsed；首块（paragraph/heading）在 UI 中充当标题，导出时提升进 <summary>
      const blocks = node.content ?? [];
      const first = blocks[0];
      const firstIsTitle = first?.type === "paragraph" || first?.type === "heading";
      const rawTitle = firstIsTitle ? renderInline(first?.content).trim() : "";
      // <summary> 是 HTML 上下文，只做 HTML 转义（markdown 转义符会原样显示）
      const title = rawTitle.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const body = firstIsTitle ? blocks.slice(1) : blocks;
      const inner = renderChildren(body, "");
      const open = node.attrs?.collapsed ? "" : " open";
      const parts = [`<details${open}>`];
      if (title) parts.push(`<summary>${title}</summary>`);
      if (inner) parts.push("", inner, "");
      parts.push("</details>");
      return parts.join("\n");
    }

    case "bulletList":
    case "taskList":
    case "orderedList": {
      const items = node.content ?? [];
      return items.map((it, i) => renderListItem(it, i, node.type === "orderedList", indent)).join("\n");
    }

    case "table": {
      // TipTap table: content = tableRow (header then body)
      // cell 内可能是多块（段落 + 图片/附件等），块级子节点逐块渲染，块间用 <br>（表格内换行惯例）
      // 历史数据/测试里 cell 也可能直接挂 inline 节点（text/image…），一并按 inline 渲染
      const inlineish = new Set(["text", "image", "mention", "hardBreak"]);
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? [])
            .map((b) => (inlineish.has(b.type ?? "") ? renderInline([b]) : renderBlock(b)))
            .filter((s) => s !== "")
            .join("<br>"),
        ),
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
      const w = (node.attrs?.width as number | undefined) ?? 100;
      return `![${alt}](${src}${w !== 100 ? `{width=${w}%}` : ""})`;
    }

    case "math": {
      // math 节点是块级 atom，唯一属性为 tex（extensions/math/node.ts），按 display math 围栏导出
      const tex = (node.attrs?.tex as string) ?? "";
      return `$$\n${tex}\n$$`;
    }

    case "mermaid": {
      // mermaid 节点是块级 atom，唯一属性为 code，按 ```mermaid 围栏导出
      const code = (node.attrs?.code as string) ?? "";
      return `\`\`\`mermaid\n${code}\n\`\`\``;
    }

    case "databaseView": {
      const viewId = (node.attrs?.viewId as string) ?? "";
      const name = (node.attrs?.name as string) || "数据库";
      return `→[${name}](db:${viewId})`;
    }

    case "columns": {
      // 带标记与结束标记：导入时可无损还原（见 markdownToJson 的分栏分支）
      const cols = node.content ?? [];
      const parts = cols.map((col, i) => `<!-- column ${i + 1}/${cols.length} -->\n${renderChildren(col.content, "")}`);
      return `<!-- columns (${cols.length}) -->\n${parts.join("\n")}\n<!-- /columns -->`;
    }

    case "imageGallery": {
      // gallery 无 attrs（子节点是 image，content: "image*"）；遍历子节点导出图片引用
      const srcs = (node.content ?? []).map((img) => (img.attrs?.src as string) ?? "");
      return `<!-- image gallery (${srcs.length} images) -->\n${srcs.map((u) => `![](${u})`).join("\n")}`;
    }

    case "outline":
      return "<!-- outline block -->";

    case "attachment": {
      // 附件节点 attrs 是 src/name（见 extensions/attachment/node.ts）
      const name = (node.attrs?.name as string) ?? "";
      const src = (node.attrs?.src as string) ?? "";
      return `[${name}](${ATTACH_PREFIX}${src})`;
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
  const nested = contents.find((c) => c.type === "bulletList" || c.type === "orderedList" || c.type === "taskList");
  const head = indent + prefix + check + renderInline(firstPara?.content);
  if (!nested) return head;
  const tail = renderBlock(nested, { indent: indent + "  " });
  return `${head}\n${tail}`;
}

function renderChildren(children: JSONContent[] | undefined, indent: string): string {
  if (!children || children.length === 0) return "";
  // 如果所有子节点都是"内联级"（text/mention/image 等，非块类型），
  // 直接拼接内联渲染结果；避免 markdownToJson 生成的 blockquote.content: [{type:'text',...}] 被当作未知块。
  const allInline = children.every(
    (n) => n.type === "text" || n.type === "mention" || n.type === "image" || n.type === "hardBreak",
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
 *       bulletList / orderedList / taskList / table / image / mention / math / mermaid /
 *       toggle / attachment / columns / databaseView（可往返）；
 * 高级块（callout/gallery/outline）输出可读占位注释，不保证严格往返，但内容可读不丢失。
 */
export function jsonToMarkdown(json: JSONContent): string {
  const root = json.type === "doc" ? json : { type: "doc", content: [json] };
  return (
    renderChildren(root.content, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
