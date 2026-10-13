import type { JSONContent } from "@tiptap/core";
import { t } from "./i18n";

// Markdown 粘贴转换（项目说明书 8.2/10-M3：粘贴 markdown 文本自动转成块）。
// 纯函数：文本 → TipTap JSON，便于 Vitest 单测。

/** 行内语法：mention/数据库链接/加粗/斜体/行内代码/删除线/高亮/下划线/图片/链接 */
const INLINE_SRC =
  "(<u>[^<\\n]*<\\/u>)|(@\\[[^\\]]*\\]\\(view:[^)\\n]+\\))|(→\\[[^\\]]*\\]\\(db:[^)\\n]+\\))|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\n]+\\*)|(`[^`\\n]+`)|(~~[^~\\n]+~~)|(==[^=\\n]+==)|(!\\[[^\\]]*\\]\\([^)\\n]+\\))|(\\[[^\\]]+\\]\\([^)\\n]+\\))";

// 每次调用新建实例：parseInline 的 <u> 分支会递归自身，共享同一个 global regex
// 会在递归中重置 lastIndex，导致外层死循环重复匹配同一段
function inlineRe(): RegExp {
  return new RegExp(INLINE_SRC, "g");
}

// 导出时 escapeInline 会给特殊符号加反斜杠；导入解析前先把 `\X` 换成私用区占位符，
// 否则 `\*literal\*` 会被当成斜体匹配，解析完再还原（正文不会出现私用区字符）。
const ESCAPE_CHARS = "`*_[]()#+-!~\\>=|<$";
const ESCAPE_PLACEHOLDER = 0xe000;

function protectEscapes(text: string): string {
  return text.replace(/\\([`*_[\]()#+\-!~\\>=|<$])/g, (_m, ch: string) =>
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
/** 相册导出头 `<!-- image gallery (n images) -->`（后跟连续图片行） */
const GALLERY_RE = /^<!--\s*image gallery\b/i;
const OUTLINE_RE = /^<!--\s*outline block\s*-->$/i;
/** callout 导出首行 `> 💡 **Callout**`（引用块内识别，emoji 取前导部分） */
const CALLOUT_HEAD_RE = /^(.*?)\s*\*\*Callout\*\*\s*$/;
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
  const re = inlineRe();
  while ((m = re.exec(source)) !== null) {
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
    } else if (raw.startsWith("<u>")) {
      // 下划线导出为 <u>…</u>：内层递归解析（可含粗斜体），给文本节点统一追加 underline mark
      for (const inner of parseInline(raw.slice(3, -4))) {
        if (inner.type === "text") {
          out.push({ type: "text", text: inner.text, marks: [...(inner.marks ?? []), { type: "underline" }] });
        } else {
          out.push(inner);
        }
      }
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

    // 相册：<!-- image gallery (n images) --> + 紧随的连续图片行（jsonToMarkdown 的导出格式），
    // 不识别注释行会把占位注释当段落文本残留
    if (GALLERY_RE.test(trimmed)) {
      i++;
      const imgs: JSONContent[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const inline = parseInline(lines[i].trim());
        const solo = inline.length === 1 ? inline[0] : undefined;
        if (solo?.type !== "image") break;
        imgs.push(solo);
        i++;
      }
      blocks.push({ type: "imageGallery", content: imgs });
      continue;
    }

    // 目录块：导出为占位注释（atom，渲染时重新扫描 heading），导入还原为空 outline
    if (OUTLINE_RE.test(trimmed)) {
      blocks.push({ type: "outline" });
      i++;
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

    // 引用：连续 > 行合并；callout 导出格式（首行 `> 💡 **Callout**`）还原为提示框块
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const head = quoteLines.length > 0 ? CALLOUT_HEAD_RE.exec(quoteLines[0]) : null;
      if (head) {
        const inner = markdownToJson(quoteLines.slice(1).join("\n"));
        blocks.push({
          type: "callout",
          attrs: { emoji: head[1].trim() !== "" ? head[1].trim() : "💡" },
          content: (inner.content?.length ?? 0) > 0 ? inner.content : [{ type: "paragraph" }],
        });
      } else {
        blocks.push({ type: "blockquote", content: parseInline(quoteLines.join(" ")) });
      }
      continue;
    }

    // 列表（待办/无序/有序）：按缩进递归构建嵌套结构（jsonToMarkdown 用两空格缩进导出嵌套项）
    const li = listItemOf(lines[i]);
    if (li) {
      const [list, next] = buildList(lines, i, li.indent);
      blocks.push(list);
      i = next;
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

interface ParsedListItem {
  indent: number;
  kind: "task" | "bullet" | "ordered";
  checked: boolean;
  text: string;
}

/** 单行 → 列表项（含缩进宽度）；非列表行返回 null */
function listItemOf(line: string): ParsedListItem | null {
  const indent = line.length - line.trimStart().length;
  const t = line.trim();
  const task = TASK_RE.exec(t);
  if (task) return { indent, kind: "task", checked: task[1].toLowerCase() === "x", text: task[2] };
  const bullet = BULLET_RE.exec(t);
  if (bullet) return { indent, kind: "bullet", checked: false, text: bullet[1] };
  const ordered = ORDERED_RE.exec(t);
  if (ordered) return { indent, kind: "ordered", checked: false, text: ordered[1] };
  return null;
}

/** 从 start 起按 indent 层构建列表；更深缩进的行递归成嵌套列表挂进当前项 */
function buildList(lines: string[], start: number, indent: number): [JSONContent, number] {
  const items: JSONContent[] = [];
  let i = start;
  let kind: "task" | "bullet" | "ordered" | null = null;
  while (i < lines.length) {
    const li = listItemOf(lines[i]);
    if (li?.indent !== indent) break;
    kind ??= li.kind;
    const para: JSONContent = { type: "paragraph", content: parseInline(li.text) };
    const item: JSONContent =
      li.kind === "task"
        ? { type: "taskItem", attrs: { checked: li.checked }, content: [para] }
        : { type: "listItem", content: [para] };
    i++;
    if (i < lines.length) {
      const deeper = listItemOf(lines[i]);
      if (deeper && deeper.indent > indent) {
        const [nested, after] = buildList(lines, i, deeper.indent);
        item.content = [...(item.content ?? []), nested];
        i = after;
      }
    }
    items.push(item);
  }
  const type = kind === "task" ? "taskList" : kind === "ordered" ? "orderedList" : "bulletList";
  return [{ type, content: items }, i];
}

/** 表格行 `| a | b |` → 单元格文本数组（`\|` 是导出时转义的单元格内容竖线，不作为分隔符） */
function splitTableRow(line: string): string[] {
  const inner = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      // 转义对原样保留（含 \|），单元格内容最终由 parseInline 还原
      cur += ch + inner[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
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
//   - 对 TipTap 原生块做精确映射；可往返块（table/columns/toggle/math/mermaid/databaseView/attachment/
//     callout/gallery/outline）的导出格式与 markdownToJson 的解析一一对应。
//   - mention 输出自定义语法 `@[label](view:<id>)`，数据库视图块（databaseView）输出 `→[label](db:<id>)`（可导入还原）。
// ——————————————————————————————————————

// 与导入侧 ESCAPE_CHARS 保持同集：= 打头会触发高亮 ==、$ 触发 $$ 数学、| 拆表格、< 触发 HTML 块
const ESCAPE_MD_RE = /([`*_[\]()#+\-!~\\>=|<$])/g;
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
  underline?: boolean;
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
        m.link = (mark.attrs?.href as string | undefined) ?? null;
        break;
      case "highlight":
        m.highlight = true;
        break;
      case "underline":
        m.underline = true;
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
  // 下划线：Markdown 无原生语法，导出 HTML <u>（导入侧 parseInline 识别还原）
  if (m.underline) out = `<u>${out}</u>`;
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
      const id = (n.attrs?.id as string | undefined) ?? "";
      const label = (n.attrs?.label as string | undefined) ?? id;
      out += `@[${label}](view:${id})`;
    } else if (n.type === "image") {
      const src = (n.attrs?.src as string | undefined) ?? "";
      const alt = (n.attrs?.alt as string | undefined) ?? "";
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
      const level = Math.max(1, Math.min(6, (node.attrs?.level as number | undefined) ?? 1));
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
      const lang = (node.attrs?.language as string | undefined) ?? "";
      const code = node.content?.map((c) => c.text ?? "").join("") ?? "";
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "callout": {
      const emoji = (node.attrs?.emoji as string | undefined) ?? "💡";
      const inner = renderChildren(node.content, "");
      const lines = inner.split("\n");
      return `> ${emoji} **Callout**\n> ${lines.join("\n> ")}`;
    }

    case "toggle": {
      // toggle 唯一属性是 collapsed；首块（paragraph/heading）在 UI 中充当标题，导出时提升进 <summary>
      const blocks = node.content ?? [];
      const first = blocks.length > 0 ? blocks[0] : undefined;
      const firstIsTitle = first?.type === "paragraph" || first?.type === "heading";
      const rawTitle = firstIsTitle ? renderInline(first.content).trim() : "";
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
      const src = (node.attrs?.src as string | undefined) ?? "";
      const alt = (node.attrs?.alt as string | undefined) ?? "";
      const w = (node.attrs?.width as number | undefined) ?? 100;
      return `![${alt}](${src}${w !== 100 ? `{width=${w}%}` : ""})`;
    }

    case "math": {
      // math 节点是块级 atom，唯一属性为 tex（extensions/math/node.ts），按 display math 围栏导出
      const tex = (node.attrs?.tex as string | undefined) ?? "";
      return `$$\n${tex}\n$$`;
    }

    case "mermaid": {
      // mermaid 节点是块级 atom，唯一属性为 code，按 ```mermaid 围栏导出
      const code = (node.attrs?.code as string | undefined) ?? "";
      return `\`\`\`mermaid\n${code}\n\`\`\``;
    }

    case "databaseView": {
      const viewId = (node.attrs?.viewId as string | undefined) ?? "";
      const name = (node.attrs?.name as string) || t("databaseView.defaultName");
      return `→[${name}](db:${viewId})`;
    }

    case "columns": {
      // 带标记与结束标记：导入时可无损还原（见 markdownToJson 的分栏分支）
      const cols = node.content ?? [];
      const parts = cols.map((col, i) => `<!-- column ${i + 1}/${cols.length} -->\n${renderChildren(col.content, "")}`);
      return `<!-- columns (${cols.length}) -->\n${parts.join("\n")}\n<!-- /columns -->`;
    }

    case "imageGallery": {
      // gallery 无 attrs（子节点是 image，content: "image*"）；导出标记注释 + 连续图片行（可导入还原）
      const imgs = (node.content ?? []).map((img) => {
        const src = (img.attrs?.src as string | undefined) ?? "";
        const alt = (img.attrs?.alt as string | undefined) ?? "";
        const w = (img.attrs?.width as number | undefined) ?? 100;
        return `![${alt}](${src}${w !== 100 ? `{width=${w}%}` : ""})`;
      });
      return `<!-- image gallery (${imgs.length} images) -->\n${imgs.join("\n")}`;
    }

    case "subpages": {
      // 子页面双链块：导出为 mention 链接列表，可被 markdownToJson 还原成 @提及
      const raw = Array.isArray(node.attrs?.items) ? (node.attrs.items as unknown[]) : [];
      const lines: string[] = [];
      for (const it of raw) {
        if (!it || typeof it !== "object") continue;
        const rec = it as { id?: unknown; name?: unknown };
        if (typeof rec.id !== "string") continue;
        lines.push(`- @[${escapeInline(typeof rec.name === "string" ? rec.name : "")}](view:${rec.id})`);
      }
      return lines.join("\n");
    }

    case "outline":
      return "<!-- outline block -->";

    case "attachment": {
      // 附件节点 attrs 是 src/name（见 extensions/attachment/node.ts）
      const name = (node.attrs?.name as string | undefined) ?? "";
      const src = (node.attrs?.src as string | undefined) ?? "";
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
 *       toggle / attachment / columns / databaseView / callout / gallery / outline（可往返）；
 * 不支持的未知块输出 `<!-- unsupported block -->` 占位注释（不保证还原，但内容可读不丢失）。
 */
export function jsonToMarkdown(json: JSONContent): string {
  const root = json.type === "doc" ? json : { type: "doc", content: [json] };
  return (
    renderChildren(root.content, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
