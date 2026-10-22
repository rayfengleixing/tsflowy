import type { JSONContent } from "@tiptap/core";
import { EMPTY_TASK_META, stripTaskMeta, type TaskMeta } from "../task-meta";

// Markdown 粘贴转换（项目说明书 8.2/10-M3：粘贴 markdown 文本自动转成块）。
// 纯函数：文本 → TipTap JSON，便于 Vitest 单测。

/** 行内语法：mention/数据库链接/加粗/斜体/行内代码/删除线/高亮/下划线/高亮色/文字色/图片/链接
 *
 *  `<u>` `<mark>` `<span>` 三段允许内层再套 HTML（正文里的 `<` 已被 protectEscapes 换成占位符，
 *  只有真标签才有 `<`），所以用「不能越过自己闭合标签」的负先行而不是 `[^<]*`：
 *  `<span style="color: …"><u>…</u></span>` 这类叠加要能递归解析下去。 */
const INLINE_SRC =
  '(<u>(?:(?!<\\/u>)[^\\n])*<\\/u>)|(<mark\\b[^<>\\n]*data-color="[^"\\n]*"[^<>\\n]*>(?:(?!<\\/mark>)[^\\n])*<\\/mark>)|(<span\\b[^<>\\n]*style="color:[^"\\n]*"[^<>\\n]*>(?:(?!<\\/span>)[^\\n])*<\\/span>)|(@\\[[^\\]]*\\]\\(view:[^)\\n]+\\))|(→\\[[^\\]]*\\]\\(db:[^)\\n]+\\))|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\n]+\\*)|(`[^`\\n]+`)|(~~[^~\\n]+~~)|(==[^=\\n]+==)|(!\\[[^\\]]*\\]\\([^)\\n]+\\))|(\\[[^\\]]+\\]\\([^)\\n]+\\))';

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
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const TASK_RE = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;
const MATH_FENCE_RE = /^\$\$\s*$/;
const MATH_ONE_LINE_RE = /^\$\$(.+)\$\$$/;
const DETAILS_RE = /^<details\b[^>]*>$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;
const SUMMARY_RE = /^<summary((?:\s[^>]*)?)>(.*)<\/summary>$/is;
const TABLE_ROW_RE = /^\|.*\|$/;
const TABLE_SEP_RE = /^\|[\s:|-]+\|$/;
const COLUMNS_RE = /^<!--\s*columns\s*\((\d+)\)\s*-->$/;
// 第三段是列宽比例；写宽一点（\S+）是为了坏值也当成标记行被归一，而不是掉进列内容里
const COLUMN_RE = /^<!--\s*column\s+(\d+)\s*\/\s*(\d+)(?:\s+(\S+))?\s*-->$/;
const COLUMNS_END_RE = /^<!--\s*\/columns\s*-->$/;
const DB_VIEW_RE = /^→\[([^\]]*)\]\(db:([^)\n]+)\)$/;
/** 相册导出头 `<!-- image gallery (n images) -->`（后跟连续图片行） */
const GALLERY_RE = /^<!--\s*image gallery\b/i;
const OUTLINE_RE = /^<!--\s*outline block\s*-->$/i;
/** callout 导出首行 `> 💡 **Callout**`（引用块内识别，emoji 取前导部分）；
 *  可选尾随 `<!-- color:orange -->` 带出色值，旧文件没有这段就按默认蓝处理 */
const CALLOUT_HEAD_RE = /^(.*?)\s*\*\*Callout\*\*(?:\s*<!--\s*color:([a-z]+)\s*-->)?\s*$/;
/** 块级对齐：Markdown 没有居中/右对齐语法，导出时在行尾挂 `<!-- align:center -->`，导入时摘掉 */
const ALIGN_RE = /\s*<!--\s*align:(left|center|right|justify)\s*-->\s*$/i;
/** 段内硬换行标记（行尾两个以上空格）；判定要在 trim 之前 */
const HARD_BREAK_RE = /[ \t]{2,}$/;
/** databaseView 指针附带的表格快照：导出写、导入整段跳过（正文只有指针） */
export const DB_TABLE_BEGIN = "<!-- db-table begin -->";
export const DB_TABLE_END = "<!-- db-table end -->";
const DB_TABLE_BEGIN_RE = /^<!--\s*db-table begin\s*-->$/i;
const DB_TABLE_END_RE = /^<!--\s*db-table end\s*-->$/i;
/** 与 callout/node.ts 的 CalloutColor 同一份名单（lib 不反向依赖 features，改一边要改另一边） */
export const CALLOUT_COLORS = ["blue", "green", "orange", "red", "purple", "yellow"];
/** 附件导出格式 `[name](attach:src)` 的协议前缀 */
export const ATTACH_PREFIX = "attach:";
/** 图片标题位 `(src "图注")` / `(src '图注')`：Markdown 原生语法，用来承载 image 的 caption。
 *  组 1 是引号、组 2 是内容；反引用只让「另一种引号」出现在内容里。 */
const IMG_TITLE_RE = /\s+(["'])((?:(?!\1)[^\n])*)\1$/;

function textWithMarks(text: string, marks: JSONContent["marks"] = []): JSONContent {
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

/** HTML 标签包裹的行内段（<u>/<mark>/<span>）：内层递归解析后统一补上 mark。
 *  非文本节点（image/mention）拿不到 mark，原样返回——和 <u>图片 一样不该崩。 */
function parseHtmlRun(raw: string, mark: { type: string; attrs?: Record<string, unknown> }): JSONContent[] {
  const body = raw.slice(raw.indexOf(">") + 1, raw.lastIndexOf("<"));
  return parseInline(body).map((node) =>
    node.type === "text" ? { ...node, marks: [...(node.marks ?? []), mark] } : node,
  );
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
      out.push(...parseHtmlRun(raw, { type: "underline" }));
    } else if (raw.startsWith("<mark")) {
      // 带色高亮：<mark data-color="#FEF3C7" …>（tiptap 自己的渲染形式，粘贴回编辑器也能还原）
      const color = /data-color="([^"\n]*)"/.exec(raw)?.[1];
      out.push(...parseHtmlRun(raw, { type: "highlight", attrs: { color } }));
    } else if (raw.startsWith("<span")) {
      // 文字色：<span style="color:#0092D6">；值可能带尾随分号或空格，摘掉再交给 mark
      const color = /style="color:\s*([^;"\n]*)/i.exec(raw)?.[1];
      out.push(...parseHtmlRun(raw, { type: "textStyle", attrs: { color } }));
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
      const rest = wm ? src.slice(0, wm.index) : src;
      // 标准 Markdown 标题位 `![alt](src "图注")`：图片 caption 借这一位往返（导出只在非空时写）
      const tm = IMG_TITLE_RE.exec(rest);
      const attrs: Record<string, unknown> = {
        src: tm ? rest.slice(0, tm.index) : rest,
        alt: inner.slice(0, close),
      };
      if (wm) attrs.width = Math.max(20, Math.min(100, Number(wm[1])));
      const caption = tm ? tm[2] : "";
      if (caption) attrs.caption = caption;
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
      /^(#{1,6})\s+/.test(l) ||
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

    // 分栏：<!-- columns (n) --> … <!-- column i/n [ratio] --> … <!-- /columns -->（jsonToMarkdown 的导出格式）
    if (COLUMNS_RE.test(trimmed)) {
      i++;
      const cols: JSONContent[] = [];
      let cur: string[] = [];
      let collecting = false;
      let ratio = 1;
      while (i < lines.length && !COLUMNS_END_RE.test(lines[i].trim())) {
        const marker = COLUMN_RE.exec(lines[i].trim());
        if (marker) {
          if (collecting) cols.push(columnToJson(cur, ratio));
          cur = [];
          collecting = true;
          ratio = parseRatio(marker[3]);
          i++;
          continue;
        }
        cur.push(lines[i]);
        i++;
      }
      i++; // 跳过 <!-- /columns -->
      if (collecting) cols.push(columnToJson(cur, ratio));
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
      // 指针下面跟着的表格只是给人看的快照：整段吞掉，否则导回来变成指针 + 副本两张表
      let j = i;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && DB_TABLE_BEGIN_RE.test(lines[j].trim())) {
        j++;
        while (j < lines.length && !DB_TABLE_END_RE.test(lines[j].trim())) j++;
        i = j + 1;
      }
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

    // 标题 1-6（与 jsonToMarkdown 的 clamp 同口径，否则 `####` 往返退化成段落）
    const h = HEADING_RE.exec(trimmed);
    if (h) {
      const { body, align } = stripAlign(h[2]);
      blocks.push({
        type: "heading",
        attrs: { level: h[1].length, ...(align ? { textAlign: align } : {}) },
        content: parseInline(body),
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
        // 只剥前导缩进与 > 标记：行尾两空格是硬换行标记，整体 trim 会把它抹掉
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const head = quoteLines.length > 0 ? CALLOUT_HEAD_RE.exec(quoteLines[0]) : null;
      if (head) {
        const inner = markdownToJson(quoteLines.slice(1).join("\n"));
        const emoji = head[1].trim() !== "" ? head[1].trim() : "💡";
        const color = CALLOUT_COLORS.includes(head[2]) ? head[2] : "blue";
        blocks.push({
          type: "callout",
          attrs: { emoji, color },
          content: (inner.content?.length ?? 0) > 0 ? inner.content : [{ type: "paragraph" }],
        });
      } else {
        // 递归解析而不是把行拼成一坨文本：引用块里的嵌套列表、代码块、多段落
        // 之前会被拍平成一行；且 blockquote 的 schema 是 block+，直接塞 text 节点
        // 进编辑器会被 TipTap 丢掉，等于引用内容不见了
        const inner = markdownToJson(quoteLines.join("\n"));
        blocks.push({
          type: "blockquote",
          content: (inner.content?.length ?? 0) > 0 ? inner.content : [{ type: "paragraph" }],
        });
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
    const rawLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      rawLines.push(lines[i]);
      i++;
    }
    const paragraph = stripAlign(rawLines.join("\n"));
    const inline = parseParagraphInline(paragraph.body);
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
    blocks.push({
      type: "paragraph",
      ...(paragraph.align ? { attrs: { textAlign: paragraph.align } } : {}),
      content: inline,
    });
  }

  return { type: "doc", content: blocks };
}

/**
 * 段落原文（可能含多行）→ inline 节点。
 * 行尾两个及以上空格是 Markdown 的硬换行标记，渲染时写成的就是这串空格，
 * 所以判断必须在 trim 之前做——先 trim 再拼会把用户的手动换行整段抹平成空格。
 * 其余相邻非空行按 Markdown 惯例算软换行，合并成一个空格。
 */
function parseParagraphInline(body: string): JSONContent[] {
  const rows = body.split("\n");
  const out: JSONContent[] = [];
  let soft: string[] = [];
  const flush = (hard: boolean) => {
    if (soft.length === 0) return;
    out.push(...parseInline(soft.join(" ")));
    soft = [];
    if (hard) out.push({ type: "hardBreak" });
  };
  rows.forEach((row, idx) => {
    soft.push(row.trim());
    if (idx < rows.length - 1 && HARD_BREAK_RE.test(row)) flush(true);
  });
  flush(false);
  return out;
}

interface ParsedListItem {
  indent: number;
  kind: "task" | "bullet" | "ordered";
  checked: boolean;
  text: string;
  /** 任务行末尾的 `<!-- task due=… assignee=… -->`；非任务行与无标记时都是空 */
  meta: TaskMeta;
}

/** 单行 → 列表项（含缩进宽度）；非列表行返回 null */
function listItemOf(line: string): ParsedListItem | null {
  const indent = line.length - line.trimStart().length;
  const t = line.trim();
  const task = TASK_RE.exec(t);
  if (task) {
    // 元数据标记先摘掉，否则 `-->` 会被当成任务正文里的普通字符导出再导回，越滚越长
    const stripped = stripTaskMeta(task[2]);
    return {
      indent,
      kind: "task",
      checked: task[1].toLowerCase() === "x",
      text: stripped.body,
      meta: stripped.meta,
    };
  }
  const bullet = BULLET_RE.exec(t);
  if (bullet) return { indent, kind: "bullet", checked: false, text: bullet[1], meta: EMPTY_TASK_META };
  const ordered = ORDERED_RE.exec(t);
  if (ordered) return { indent, kind: "ordered", checked: false, text: ordered[1], meta: EMPTY_TASK_META };
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
    // 没有元数据时不带 due/assignee 键：旧导出文件的 JSON 形状保持不变，往返用例也不会多出两个 null
    const metaAttrs = {
      ...(li.meta.due ? { due: li.meta.due } : {}),
      ...(li.meta.assignee ? { assignee: li.meta.assignee } : {}),
    };
    const item: JSONContent =
      li.kind === "task"
        ? { type: "taskItem", attrs: { checked: li.checked, ...metaAttrs }, content: [para] }
        : { type: "listItem", content: [para] };
    i++;
    // 项内后续内容：更深缩进的行里，列表标记归嵌套列表，其余是本项的续行块
    // （第二段、代码块、图片——导出时统一缩进两格，见 renderListItem）
    const cont: string[] = [];
    const contIndent = " ".repeat(indent + 2);
    const flushCont = () => {
      while (cont.length > 0 && cont[cont.length - 1] === "") cont.pop();
      if (cont.length === 0) return;
      const inner = markdownToJson(cont.join("\n"));
      item.content = [...(item.content ?? []), ...(inner.content ?? [])];
      cont.length = 0;
    };
    while (i < lines.length) {
      const raw = lines[i];
      const deeper = listItemOf(raw);
      if (deeper && deeper.indent > indent) {
        flushCont();
        const [nested, after] = buildList(lines, i, deeper.indent);
        item.content = [...(item.content ?? []), nested];
        i = after;
        continue;
      }
      if (raw.trim() === "") {
        // 空行只有后面还接着更深缩进的内容时才属于本项（代码块里的空行、段落间距）
        const next = lines.slice(i + 1).find((l) => l.trim() !== "");
        if (next === undefined || next.length - next.trimStart().length <= indent) break;
        cont.push("");
        i++;
        continue;
      }
      if (raw.length - raw.trimStart().length <= indent) break;
      cont.push(raw.startsWith(contIndent) ? raw.slice(contIndent.length) : raw.trimStart());
      i++;
    }
    flushCont();
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

/** `<br>` 分隔的文本（HTML 上下文里的换行）→ inline 节点序列，分隔处落 hardBreak */
function inlineWithBr(text: string): JSONContent[] {
  const inline: JSONContent[] = [];
  text.split(/<br\s*\/?>/i).forEach((part, idx) => {
    if (idx > 0) inline.push({ type: "hardBreak" });
    // 老导出把 align 标记写进了单元格，摘掉免得当成正文显示
    inline.push(...parseInline(part.replace(ALIGN_RE, "")));
  });
  return inline;
}

/** 单元格文本 → 单元格内容：导出时单元格内多块用 <br> 连接，导回时还原为 hardBreak */
function cellContent(text: string): JSONContent[] {
  return [{ type: "paragraph", content: inlineWithBr(text) }];
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

/** 分栏标记里的列宽比例：缺省或坏数据按 1（均分）处理 */
function parseRatio(raw: string | undefined): number {
  const value = Number(raw ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.min(20, Math.max(0.05, value)) : 1;
}

/** column 节点的列宽比例（供 Markdown 与 HTML 导出共用）：坏数据退回均分 */
export function columnRatioOf(node: JSONContent): number {
  return parseRatio(node.attrs?.ratio === undefined ? undefined : String(node.attrs.ratio));
}

/** 分栏内容行 → column 节点（递归走 markdownToJson，空列补空段落） */
function columnToJson(lines: string[], ratio = 1): JSONContent {
  const inner = markdownToJson(lines.join("\n")).content ?? [];
  return { type: "column", attrs: { ratio }, content: inner.length > 0 ? inner : [{ type: "paragraph" }] };
}

/** <details> 内部行 → toggle 节点：<summary> 还原为标题段落，其余递归走 markdownToJson */
function detailsToToggle(innerLines: string[], isOpen: boolean): JSONContent {
  const content: JSONContent[] = [];
  let start = 0;
  while (start < innerLines.length && innerLines[start].trim() === "") start++;
  const summary = SUMMARY_RE.exec(innerLines[start]?.trim() ?? "");
  if (summary) {
    // 导出时标题做了 HTML 转义（& < 等），导入时先解码再走行内解析
    // 标题级别记在 data-level 上：不带它时，标题型 toggle 导回会退化成普通段落
    const level = Number(/data-level="([1-6])"/.exec(summary[1])?.[1] ?? 0);
    // summary 是 HTML 上下文，标题里的换行导出成 <br>
    const text = inlineWithBr(decodeHtmlEntities(summary[2]));
    content.push(
      level > 0 ? { type: "heading", attrs: { level }, content: text } : { type: "paragraph", content: text },
    );
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

/** 从行尾摘掉对齐注释，返回去掉注释的正文与对齐值 */
function stripAlign(text: string): { body: string; align: string | null } {
  const match = ALIGN_RE.exec(text);
  if (!match) return { body: text, align: null };
  return { body: text.slice(0, match.index), align: match[1].toLowerCase() };
}
