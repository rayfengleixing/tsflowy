import type { JSONContent } from "@tiptap/core";
import { t } from "../i18n";
import { encodeTaskMeta, taskMetaOf } from "../doc/task-meta";
import { ATTACH_PREFIX, CALLOUT_COLORS, DB_TABLE_BEGIN, DB_TABLE_END, columnRatioOf } from "./parse";

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
export function colorAttr(raw: unknown): string | undefined {
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

/** inTable：表格单元格里的换行必须写成 <br>，行尾两空格那套会把 GFM 表格拆成两行 */
function renderInline(nodes: JSONContent[] | undefined, inTable = false): string {
  if (!nodes || nodes.length === 0) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" && typeof n.text === "string") {
      const m = marksOf(n);
      // code mark 不转义内部内容
      const raw = m.code ? n.text : escapeInline(n.text);
      out += wrapMarks(raw, m);
    } else if (n.type === "hardBreak") {
      // 段内换行的标准写法是行尾两空格；只写 \n 会被回读当成同段续行，换行整个丢失
      out += inTable ? "<br>" : "  \n";
    } else if (n.type === "mention") {
      const id = (n.attrs?.id as string | undefined) ?? "";
      const label = (n.attrs?.label as string | undefined) ?? id;
      out += `@[${label}](view:${id})`;
    } else if (n.type === "image") {
      out += imageMarkdown(n.attrs);
    } else {
      // 其他 inline（date/relations/hardBreak emoji 等）：回退到 textContent
      if (typeof n.text === "string") out += escapeInline(n.text);
      if (Array.isArray(n.content)) out += renderInline(n.content, inTable);
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
  /** 渲染发生在表格单元格内：换行只能用 <br> */
  inTable?: boolean;
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

/** 标题级别钳到 1-6：坏数据（字符串、0、8）不能让导出产出 `#######` 或空串 */
function headingLevel(node: JSONContent): number {
  const raw = Number(node.attrs?.level ?? 1);
  return Math.max(1, Math.min(6, Number.isFinite(raw) ? raw : 1));
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

/** callout 的 color attr → 合法色名（坏数据与缺省都按蓝）；HTML 导出按同一个口径上色 */
export function calloutColorOf(node: JSONContent): string {
  const value: unknown = node.attrs?.color;
  return typeof value === "string" && CALLOUT_COLORS.includes(value) ? value : "blue";
}

function renderBlock(node: JSONContent, ctx: RenderCtx = { indent: "" }): string {
  const indent = ctx.indent;
  const inTable = ctx.inTable === true;
  const kids = (content: JSONContent[] | undefined, nextIndent = ""): string =>
    renderChildren(content, { indent: nextIndent, tables: ctx.tables, inTable: ctx.inTable });
  switch (node.type) {
    case "paragraph":
      // 单元格放不下块级对齐：GFM 里没有这个语法，写进去只会被读成正文里的注释残迹
      return renderInline(node.content, inTable) + (inTable ? "" : alignSuffix(node));

    case "heading": {
      const hashes = "#".repeat(headingLevel(node));
      return `${hashes} ${renderInline(node.content, inTable)}${inTable ? "" : alignSuffix(node)}`;
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
      const rawTitle = firstIsTitle ? renderInline(first.content, true).trim() : "";
      // <summary> 是 HTML 上下文，只做 HTML 转义（markdown 转义符会原样显示）
      const title = rawTitle.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const body = firstIsTitle ? blocks.slice(1) : blocks;
      const inner = kids(body, "");
      const open = node.attrs?.collapsed ? "" : " open";
      // 标题型 toggle 的级别记在 summary 的属性上，否则导回来一律是段落
      const levelAttr = first?.type === "heading" ? ` data-level="${headingLevel(first)}"` : "";
      const parts = [`<details${open}>`];
      if (title) parts.push(`<summary${levelAttr}>${title}</summary>`);
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
          // 块尾自带的 <br>（段内硬换行落到最后一行）先削掉：块间分隔符会补回来，
          // 否则单元格读出两个连排 hardBreak
          text: (cell.content ?? [])
            .map((b) =>
              inlineish.has(b.type ?? "")
                ? renderInline([b], true)
                : renderBlock(b, { indent: "", tables: ctx.tables, inTable: true }),
            )
            .map((s) => s.replace(/(?:<br>\s*)+$/, ""))
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
      // 附表只是给人看的快照：包进注释围栏，导回时整段跳过，否则指针 + 副本 = 同一张表出现两次
      if (!table) return pointer;
      return `${pointer}\n\n${DB_TABLE_BEGIN}\n${table}\n${DB_TABLE_END}`;
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
  // 任务行的日期/负责人跟在正文后、嵌套子项前，回读时由 stripTaskMeta 摘走
  const meta = item.type === "taskItem" ? encodeTaskMeta(taskMetaOf(item.attrs)) : "";
  const contents = item.content ?? [];
  // 首块是段落时写在标记行上；项内其它块（第二段、代码块、图片、嵌套列表）
  // 一律缩进两格续写。旧写法只取「第一个 paragraph + 第一个列表」，
  // 其余块在导出时被整块吞掉，用户只在换库导入后才发现内容少了。
  const headIsPara = contents[0]?.type === "paragraph";
  const head =
    indent + prefix + check + (headIsPara ? renderInline(contents[0]?.content, ctx.inTable === true) : "") + meta;
  const rest = headIsPara ? contents.slice(1) : contents;
  if (rest.length === 0) return head;
  const tail = rest.map((b) => renderBlock(b, { ...ctx, indent: indent + "  " })).join("\n");
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
  if (allInline) return indent + renderInline(children, ctx.inTable === true);
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
