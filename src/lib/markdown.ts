import type { JSONContent } from "@tiptap/core";
import { t } from "./i18n";
import { EMPTY_TASK_META, encodeTaskMeta, stripTaskMeta, taskMetaOf, type TaskMeta } from "./task-meta";

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
const SUMMARY_RE = /^<summary>(.*)<\/summary>$/i;
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
/** 与 callout/node.ts 的 CalloutColor 同一份名单（lib 不反向依赖 features，改一边要改另一边） */
const CALLOUT_COLORS = ["blue", "green", "orange", "red", "purple", "yellow"];
/** 附件导出格式 `[name](attach:src)` 的协议前缀 */
const ATTACH_PREFIX = "attach:";
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
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
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
    const paragraph = stripAlign(buf.join(" "));
    const inline = parseInline(paragraph.body);
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
  /** 高亮色（multicolor Highlight 的 attrs.color）；空值走默认 `==文本==` */
  highlightColor?: string;
  underline?: boolean;
  /** 文字色（TextStyle + Color 的 attrs.color）；"inherit" 是「恢复默认色」，等价于无 mark */
  textColor?: string;
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
        m.highlightColor = colorAttr(mark.attrs?.color);
        break;
      case "underline":
        m.underline = true;
        break;
      case "textStyle":
        m.textColor = colorAttr(mark.attrs?.color);
        break;
      // font-size/line-height 等 TextStyle 的其他属性仍不映射 Markdown，保留纯文本即可
    }
  }
  return m;
}

/** 颜色 mark 属性：空值与 "inherit"（编辑器「默认色」档）都当没有颜色 */
function colorAttr(raw: unknown): string | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value && value !== "inherit" ? value : undefined;
}

/** 高亮 / 文字色的 HTML 段：属性值来自编辑器色板，含空格所以导出用 `; ` 分隔 */
function htmlColorRun(tag: "mark" | "span", color: string, inner: string): string {
  if (tag === "mark") {
    return `<mark data-color="${color}" style="background-color: ${color}; color: inherit">${inner}</mark>`;
  }
  return `<span style="color: ${color}">${inner}</span>`;
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
  // highlight：Markdown 无原生语法，默认色用 ==包裹（Obsidian/Notion 兼容）；
  // 带色只能导成 <mark>，否则色值在往返里丢掉
  if (m.highlight) out = m.highlightColor ? htmlColorRun("mark", m.highlightColor, out) : `==${out}==`;
  // 下划线：Markdown 无原生语法，导出 HTML <u>（导入侧 parseInline 识别还原）
  if (m.underline) out = `<u>${out}</u>`;
  // 文字色：同 <u>，套在最外层（<span> 能包住 <u>/<mark>，反过来会让内层标签正则匹配不上）
  if (m.textColor) out = htmlColorRun("span", m.textColor, out);
  return out;
}

/** caption 进图片标题位前的消毒：内层解析 `![…](…)` 匹配到第一个 `)` 就收，
 *  半角括号会截断语法（换全角保可读），引号会打乱标题边界（换单引号），换行折成空格。 */
function captionForMd(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .trim();
}

/** 图片导出：`![alt](src "caption"){width=60%}`——caption 借标准标题位，空值不写 */
function imageMarkdown(attrs: Record<string, unknown> | undefined): string {
  const src = (attrs?.src as string | undefined) ?? "";
  const alt = (attrs?.alt as string | undefined) ?? "";
  const caption = captionForMd(attrs?.caption);
  const width = (attrs?.width as number | undefined) ?? 100;
  const target = `${src}${caption ? ` "${caption}"` : ""}${width !== 100 ? `{width=${width}%}` : ""}`;
  return `![${alt}](${target})`;
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
      out += imageMarkdown(n.attrs);
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

/** 导出渲染上下文：indent 为当前缩进；tables 为「viewId → Markdown 表格文本」，
 *  由调用方（整库导出）预先取好，让本模块保持同步纯函数 */
interface RenderCtx {
  orderedIndex?: number;
  indent: string;
  tables?: Record<string, string>;
}

/** 单元格上的合并属性：历史数据里 attr 可能是字符串或缺省，一律当 1 处理 */
function numAttr(node: JSONContent, key: "colspan" | "rowspan"): number {
  const raw = Number(node.attrs?.[key] ?? 1);
  return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 1;
}

/**
 * 把带 colspan/rowspan 的一行行单元格摊成矩形网格。
 * 模型里被合并覆盖的位置本来就没有节点，所以只需按锚点格占位、覆盖格补空串，
 * 最后把长短不一的行补齐到总列宽（GFM 要求每行列数相同）。
 */
function flattenTableGrid(rows: { text: string; colspan: number; rowspan: number }[][]): string[][] {
  const grid: (string | null)[][] = rows.map(() => []);
  const put = (r: number, c: number, v: string | null) => {
    while (grid.length <= r) grid.push([]); // 坏数据里 rowspan 超出真实行数也不能崩
    while (grid[r].length <= c) grid[r].push(null);
    grid[r][c] = v;
  };
  // 已占位 = 该列存着字符串（null 是补的空位，越界是还没写到的列，两者都算空）
  const taken = (r: number, c: number) => typeof grid[r][c] === "string";
  rows.forEach((cells, r) => {
    let col = 0;
    for (const cell of cells) {
      while (taken(r, col)) col++;
      for (let dr = 0; dr < cell.rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          put(r + dr, col + dc, dr === 0 && dc === 0 ? cell.text : "");
        }
      }
      col += cell.colspan;
    }
  });
  const width = Math.max(...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ""));
}

/** 块级对齐（TextAlign 扩展的 textAlign attr）：Markdown 无此语法，导出挂在行尾注释里 */
const ALIGN_VALUES = ["left", "center", "right", "justify"];

/** 合法对齐值，缺省/left/坏数据返回 null（与 defaultAlignment 同义，不必额外记录） */
export function alignValueOf(node: JSONContent): string | null {
  const value: unknown = node.attrs?.textAlign;
  if (typeof value !== "string") return null;
  const align = value.toLowerCase();
  return align === "left" ? null : ALIGN_VALUES.includes(align) ? align : null;
}

function alignSuffix(node: JSONContent): string {
  // 缺省与 left 视觉一致，不写注释，避免每段都拖一条尾巴
  const align = alignValueOf(node);
  return align ? ` <!-- align:${align} -->` : "";
}

/** 从行尾摘掉对齐注释，返回去掉注释的正文与对齐值 */
function stripAlign(text: string): { body: string; align: string | null } {
  const match = ALIGN_RE.exec(text);
  if (!match) return { body: text, align: null };
  return { body: text.slice(0, match.index), align: match[1].toLowerCase() };
}

/** callout 的 color attr → 合法色名（坏数据与缺省都按蓝）；HTML 导出按同一个口径上色 */
export function calloutColorOf(node: JSONContent): string {
  const value: unknown = node.attrs?.color;
  return typeof value === "string" && CALLOUT_COLORS.includes(value) ? value : "blue";
}

function renderBlock(node: JSONContent, ctx: RenderCtx = { indent: "" }): string {
  const indent = ctx.indent;
  const kids = (content: JSONContent[] | undefined, nextIndent = ""): string =>
    renderChildren(content, { indent: nextIndent, tables: ctx.tables });
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content) + alignSuffix(node);

    case "heading": {
      const level = Math.max(1, Math.min(6, (node.attrs?.level as number | undefined) ?? 1));
      const hashes = "#".repeat(level);
      return `${hashes} ${renderInline(node.content)}${alignSuffix(node)}`;
    }

    case "horizontalRule":
      return "---";

    case "blockquote": {
      const inner = kids(node.content, "");
      return indentLines(inner, "> ").replace(/^> $/gm, ">");
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string | undefined) ?? "";
      const code = node.content?.map((c) => c.text ?? "").join("") ?? "";
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "callout": {
      const emoji = (node.attrs?.emoji as string | undefined) ?? "💡";
      const color = calloutColorOf(node);
      // 蓝色是默认值，不写注释，历史导出格式保持不变
      const mark = color === "blue" ? "" : ` <!-- color:${color} -->`;
      const inner = kids(node.content, "");
      const lines = inner.split("\n");
      return `> ${emoji} **Callout**${mark}\n> ${lines.join("\n> ")}`;
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
      const inner = kids(body, "");
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
      return items.map((it, i) => renderListItem(it, i, node.type === "orderedList", ctx)).join("\n");
    }

    case "table": {
      // TipTap table: content = tableRow (header then body)
      // cell 内可能是多块（段落 + 图片/附件等），块级子节点逐块渲染，块间用 <br>（表格内换行惯例）
      // 历史数据/测试里 cell 也可能直接挂 inline 节点（text/image…），一并按 inline 渲染
      const inlineish = new Set(["text", "image", "mention", "hardBreak"]);
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) => ({
          text: (cell.content ?? [])
            .map((b) =>
              inlineish.has(b.type ?? "") ? renderInline([b]) : renderBlock(b, { indent: "", tables: ctx.tables }),
            )
            .filter((s) => s !== "")
            .join("<br>"),
          colspan: numAttr(cell, "colspan"),
          rowspan: numAttr(cell, "rowspan"),
        })),
      );
      if (rows.length === 0) return "";
      // GFM 表格没有跨行跨列语法：合并只能在导出时摊平成一个矩形网格——
      // 内容留在锚点格，被覆盖的位置补空。宁可丢掉合并，也不能导出短一行/长一行的坏表。
      const grid = flattenTableGrid(rows);
      const [header, ...body] = grid;
      const sep = `| ${header.map(() => "---").join(" | ")} |`;
      const renderRow = (r: string[]) => `| ${r.join(" | ")} |`;
      const out = [renderRow(header), sep, ...body.map(renderRow)];
      return out.join("\n");
    }

    case "image":
      return imageMarkdown(node.attrs);

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
      const pointer = `→[${name}](db:${viewId})`;
      // 表格文本由调用方预取（见 export-folder 的 databaseTables）：读不到就只留指针，不能让导出中断
      const table = ctx.tables?.[viewId];
      return table ? `${pointer}\n\n${table}` : pointer;
    }

    case "columns": {
      // 带标记与结束标记：导入时可无损还原（见 markdownToJson 的分栏分支）
      // ratio 为 1（均分）时不写第三段，保持与历史导出格式一致
      const cols = node.content ?? [];
      const parts = cols.map((col, i) => {
        const ratio = columnRatioOf(col);
        const mark = ratio === 1 ? "" : ` ${ratio}`;
        return `<!-- column ${i + 1}/${cols.length}${mark} -->\n${kids(col.content, "")}`;
      });
      return `<!-- columns (${cols.length}) -->\n${parts.join("\n")}\n<!-- /columns -->`;
    }

    case "imageGallery": {
      // gallery 无 attrs（子节点是 image，content: "image*"）；导出标记注释 + 连续图片行（可导入还原）
      const imgs = (node.content ?? []).map((img) => imageMarkdown(img.attrs));
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
        return `<!-- unsupported block: ${node.type} -->\n${kids(node.content, indent)}`;
      }
      return `<!-- unsupported block: ${node.type} -->`;
  }
}

function renderListItem(item: JSONContent, index: number, ordered: boolean, ctx: RenderCtx): string {
  // item.type 预期：listItem 或 taskItem
  const indent = ctx.indent;
  const prefix = ordered ? `${index + 1}. ` : "- ";
  const check = item.type === "taskItem" ? (item.attrs?.checked ? "[x] " : "[ ] ") : "";
  // item.content = [paragraph, ?nestedList, ...]
  const contents = item.content ?? [];
  const firstPara = contents.find((c) => c.type === "paragraph");
  const nested = contents.find((c) => c.type === "bulletList" || c.type === "orderedList" || c.type === "taskList");
  // 任务行的日期/负责人跟在正文后、嵌套子项前，回读时由 stripTaskMeta 摘走
  const meta = item.type === "taskItem" ? encodeTaskMeta(taskMetaOf(item.attrs)) : "";
  const head = indent + prefix + check + renderInline(firstPara?.content) + meta;
  if (!nested) return head;
  const tail = renderBlock(nested, { ...ctx, indent: indent + "  " });
  return `${head}\n${tail}`;
}

function renderChildren(children: JSONContent[] | undefined, ctx: RenderCtx): string {
  const indent = ctx.indent;
  if (!children || children.length === 0) return "";
  // 如果所有子节点都是"内联级"（text/mention/image 等，非块类型），
  // 直接拼接内联渲染结果；避免 markdownToJson 生成的 blockquote.content: [{type:'text',...}] 被当作未知块。
  const allInline = children.every(
    (n) => n.type === "text" || n.type === "mention" || n.type === "image" || n.type === "hardBreak",
  );
  if (allInline) return indent + renderInline(children);
  const parts: string[] = [];
  for (const c of children) parts.push(renderBlock(c, ctx));
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
 *
 * opts.databaseTables：viewId → 该数据库视图的 Markdown 表格文本。数据库内容存在 SQLite 里，
 * 取数要跨 IPC（异步），而本函数是同步纯函数，所以由调用方预先取好再传进来（见 export-folder）。
 */
export function jsonToMarkdown(json: JSONContent, opts?: { databaseTables?: Record<string, string> }): string {
  const root = json.type === "doc" ? json : { type: "doc", content: [json] };
  return (
    renderChildren(root.content, { indent: "", tables: opts?.databaseTables })
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
