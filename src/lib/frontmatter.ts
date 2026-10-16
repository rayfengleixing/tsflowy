import { LAYOUTS, type LayoutType } from "@/types/models";

// Markdown 文件头部元信息（YAML 子集）。
//
// 只支持本库真正要往返的四项：标题、图标、标签、收藏，外加布局标记。
// 语法范围刻意收窄到 `key: 标量` 与 `key: [a, b]` —— 支持完整 YAML 需要引号别名、
// 锚点、多行折叠，收益不抵解析风险。Obsidian/Jekyll 的其它字段（如 `aliases:`）原样丢弃。

const LAYOUT_VALUES: readonly LayoutType[] = LAYOUTS;

export interface PageMeta {
  title?: string;
  icon?: string;
  layout?: LayoutType;
  tags?: string[];
  favorite?: boolean;
  /** 毫秒时间戳（导出时写 ISO，导入时读回） */
  updatedAtMs?: number;
}

export interface Frontmatter {
  meta: PageMeta;
  /** 去掉 frontmatter 块之后的正文 */
  body: string;
}

/** 标量是否需要加引号：含分隔/引用字符（`, " [ ] #` 等）、首尾空格、或看起来像布尔与数字 */
function needsQuote(v: string): boolean {
  if (v === "") return true;
  if (/^[\s>|&*!%@'"#[\]{}]/.test(v) || /\s$/.test(v)) return true;
  // 值里出现这些字符时不引号，会在解析时被当成结构（列表分隔、注释、引用起始）
  if (/["#,[\]]/.test(v)) return true;
  return /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v);
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

/** 页面元信息 → frontmatter 文本（含结尾换行）；无内容时返回空串 */
export function buildFrontmatter(meta: PageMeta): string {
  const lines: string[] = ["---"];
  if (meta.title) lines.push(`title: ${needsQuote(meta.title) ? quote(meta.title) : meta.title}`);
  if (meta.icon) lines.push(`icon: ${needsQuote(meta.icon) ? quote(meta.icon) : meta.icon}`);
  if (meta.layout && meta.layout !== "document") lines.push(`layout: ${meta.layout}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((x) => (needsQuote(x) ? quote(x) : x)).join(", ")}]`);
  }
  if (meta.favorite === true) lines.push("favorite: true");
  if (typeof meta.updatedAtMs === "number" && Number.isFinite(meta.updatedAtMs)) {
    lines.push(`updated_at: ${new Date(meta.updatedAtMs).toISOString()}`);
  }
  if (lines.length === 1) return "";
  lines.push("---", "");
  return lines.join("\n");
}

/** `[a, "b,c"]` → 成员数组：按引号外的逗号切分（引号内的逗号属于值本身） */
function splitList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") {
      quoted = !quoted;
      cur += ch;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x !== "");
}
/** 拆分并解析文件头；没有合法 frontmatter 块时原样返回（body = 全文） */
export function splitFrontmatter(md: string): Frontmatter {
  const text = md.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { meta: {}, body: md };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: md };
  const rawBlock = text.slice(4, end).split("\n");
  const bodyStart = text.indexOf("\n", end + 4);
  const body = bodyStart < 0 ? "" : text.slice(bodyStart + 1);

  const meta: PageMeta = {};
  for (const line of rawBlock) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "title") {
      const v = unquote(value);
      if (v !== "") meta.title = v;
    } else if (key === "icon") {
      const v = unquote(value);
      if (v !== "") meta.icon = v;
    } else if (key === "layout") {
      const v = unquote(value) as LayoutType;
      if (LAYOUT_VALUES.includes(v)) meta.layout = v;
    } else if (key === "tags") {
      const list = splitList(value);
      if (list.length > 0) meta.tags = list;
    } else if (key === "favorite") meta.favorite = /^(true|1|yes)$/i.test(unquote(value));
    else if (key === "updated_at") {
      const d = new Date(unquote(value));
      if (!Number.isNaN(d.getTime())) meta.updatedAtMs = d.getTime();
    }
  }
  return { meta, body };
}
