import { parseViewTags, type LayoutType, type View } from "@/types/models";
import { invoke } from "@/lib/invoke";
import { pinyinInitials } from "@/lib/pinyin-initials";

// 全文搜索（项目说明书 12 节风险 1：FTS5 trigram 支持中文子串检索）。
// 结果排序为纯函数，便于 Vitest 单测；DB 访问集中在 searchApi。
// Phase B：FTS 转义（escapeFts/likePattern）与两条查询已下沉 Rust（db::search），
// JS 侧保留限定符与关键词切分（多词 AND / "短语" / -排除，规则与 Rust parse_query_terms 对齐）、
// 空查询短路、<em> 清洗与标题分层排序。

export interface SearchHit {
  view_id: string;
  title: string;
  icon: string | null;
  layout: LayoutType;
  /** 正文命中片段（含 <em> 标记），标题命中或无名片段时为空串 */
  snippet: string;
  /** 命中的数据库行 id：仅单元格命中有值，用来在表格里定位那一行 */
  row_id?: string | null;
}

interface SearchRow extends SearchHit {
  rank: number;
}

/** 标题匹配层级：0 精确 = 1 前缀 = 2 包含 = 3 拼音首字母命中 = 4 仅正文命中 */
export const TIER_BODY_ONLY = 4;

/**
 * 标题匹配层级。拼音首字母（输入 "bj" 命中「笔记」）排在正文命中之前：
 * 标题是用户最可能的意图，而拼音匹配是标题匹配的一种弱形式。
 * 查询为汉字时不会命中拼音分支（首字母串只有字母），走原路即可。
 */
export function titleTier(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.trim().toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  const py = pinyinInitials(title).toLowerCase();
  if (py.includes(q)) return 3;
  return TIER_BODY_ONLY;
}

/** 多词查询的标题层级：每个词都得沾上标题（AND 语义），取最弱的那个词定层级 */
export function titleTierFor(title: string, terms: string[]): number {
  if (terms.length === 0) return TIER_BODY_ONLY;
  let tier = 0;
  for (const term of terms) {
    const t = titleTier(title, term);
    if (t >= TIER_BODY_ONLY) return TIER_BODY_ONLY;
    tier = Math.max(tier, t);
  }
  return tier;
}

/** 标题是否命中任一排除词（无正向词时是唯一可验证的排除依据） */
export function titleExcluded(title: string, exclude: string[]): boolean {
  return exclude.some((term) => titleTier(title, term) < TIER_BODY_ONLY);
}

/** 仅标题/拼音可确定的命中（不做正文检索）：本地即时补全命令面板与结果页用 */
export function localTitleHits(views: View[], terms: string[], exclude: string[] = []): SearchRow[] {
  if (terms.length === 0) return [];
  return views
    .filter((v) => titleTierFor(v.name, terms) < TIER_BODY_ONLY && !titleExcluded(v.name, exclude))
    .map((v) => ({
      view_id: v.id,
      title: v.name,
      icon: v.icon ?? null,
      layout: v.layout,
      snippet: "",
      rank: 0, // 同一层级内本地标题命中排 FTS 命中之前
    }));
}

/** FTS 命中 + 本地标题命中合并去重（同一 view 以 FTS 行优先，保留其正文片段）后统一排序 */
export function mergeSearchRows(fts: SearchRow[], local: SearchRow[], terms: string[]): SearchHit[] {
  const seen = new Set(fts.map((r) => r.view_id));
  return prioritizeSearchRows([...fts, ...local.filter((r) => !seen.has(r.view_id))], terms);
}

/** 标题优先、同层按 FTS rank 升序 */
export function prioritizeSearchRows(rows: SearchRow[], terms: string[]): SearchHit[] {
  return [...rows]
    .sort((a, b) => {
      const ta = titleTierFor(a.title, terms);
      const tb = titleTierFor(b.title, terms);
      if (ta !== tb) return ta - tb;
      return a.rank - b.rank;
    })
    .map(({ rank: _rank, ...hit }) => hit);
}

/** 片段防注入：只保留 <em>/</em>，其余标签一律剥掉 */
export function sanitizeSnippet(snippet: string): string {
  return snippet.replace(/<(?!\/?em>)[^>]*>/g, "");
}

/** 搜索限定符解析结果。
 * text 是原样保留引号与 `-` 的关键词串（FTS 语法在 Rust 侧解析）；
 * terms/exclude 是去引号后的正向词与排除词，供本地标题命中、拼音召回与高亮用。
 */
export interface ParsedQuery {
  text: string;
  terms: string[];
  exclude: string[];
  layouts: LayoutType[];
  tags: string[];
}

/** 一个检索项：text 已去引号，raw 是原样串（含引号/减号） */
interface QueryToken {
  raw: string;
  text: string;
  excluded: boolean;
}

const SPACE = /\s/;

/**
 * 关键词切分：空白分词、`"..."` 为精确短语、`-` 前缀为排除项。
 * 与 Rust 侧 parse_query_terms 同规则（引号不再嵌套，未闭合则读到结尾），
 * 否则本地标题命中会和 DB 结果对不上。
 */
function tokenizeQueryTerms(input: string): QueryToken[] {
  const out: QueryToken[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && SPACE.test(input[i])) i++;
    if (i >= input.length) break;
    const start = i;
    const excluded = input[i] === "-";
    if (excluded) i++;
    const quoted = input[i] === '"';
    if (quoted) i++;
    const textStart = i;
    while (i < input.length) {
      const c = input[i];
      if (c === '"') break;
      if (!quoted && SPACE.test(c)) break;
      i++;
    }
    const text = input.slice(textStart, i);
    if (quoted && i < input.length) i++;
    if (text) out.push({ raw: input.slice(start, i), text, excluded });
  }
  return out;
}

/** type: 取值 → 布局集合；database/db 展开为全部数据库视图布局 */
const DB_LAYOUTS: LayoutType[] = ["grid", "board", "calendar", "timeline"];
const TYPE_ALIASES: Record<string, LayoutType[] | "database" | undefined> = {
  page: ["document"],
  doc: ["document"],
  document: ["document"],
  table: ["grid"],
  grid: ["grid"],
  board: ["board"],
  calendar: ["calendar"],
  db: "database",
  database: "database",
  页面: ["document"],
  文档: ["document"],
  表格: ["grid"],
  看板: ["board"],
  日历: ["calendar"],
  数据库: "database",
};

/**
 * 解析搜索输入：识别 `type:页面|数据库|board` 与 `tag:标签` 限定符，其余词进入全文检索。
 * 关键词语法：空格分词（多词 AND）、`"精确短语"`、`-词` / `-"短语"` 排除。
 * 未知 type 值静默忽略，避免误当成正文词；`-type:` 形式的负限定符不支持（当普通排除词处理）。
 */
export function parseSearchQuery(input: string): ParsedQuery {
  const layouts = new Set<LayoutType>();
  const tags: string[] = [];
  const terms: string[] = [];
  const exclude: string[] = [];
  const kept: string[] = [];
  for (const tk of tokenizeQueryTerms(input)) {
    const m = tk.excluded ? null : /^(type|tag):(.*)$/i.exec(tk.text);
    if (m === null) {
      kept.push(tk.raw);
      (tk.excluded ? exclude : terms).push(tk.text);
      continue;
    }
    const value = m[2].trim();
    if (!value) continue;
    if (m[1].toLowerCase() === "type") {
      const alias = TYPE_ALIASES[value.toLowerCase()];
      if (alias === "database") DB_LAYOUTS.forEach((l) => layouts.add(l));
      else if (alias) alias.forEach((l) => layouts.add(l));
    } else {
      tags.push(value.toLowerCase());
    }
  }
  return { text: kept.join(" "), terms, exclude, layouts: [...layouts], tags };
}

/** 单个视图是否满足限定符（仅看布局与标签） */
export function matchesQualifiers(view: View, parsed: ParsedQuery): boolean {
  if (parsed.layouts.length > 0 && !parsed.layouts.includes(view.layout)) return false;
  if (parsed.tags.length > 0) {
    const tags = parseViewTags(view.tags).map((x) => x.toLowerCase());
    if (!parsed.tags.every((tag) => tags.includes(tag))) return false;
  }
  return true;
}

/** 只有限定符、没有关键词时：本地列出满足条件的视图（不做正文检索），排除项只能按标题核验 */
export function localQualifierHits(views: View[], parsed: ParsedQuery): SearchRow[] {
  return views
    .filter((v) => matchesQualifiers(v, parsed) && !titleExcluded(v.name, parsed.exclude))
    .map((v) => ({ view_id: v.id, title: v.name, icon: v.icon ?? null, layout: v.layout, snippet: "", rank: 0 }));
}

/** 按限定符过滤命中结果；tagsOf 提供 view_id → 小写标签数组的映射 */
export function filterHits(hits: SearchHit[], parsed: ParsedQuery, tagsOf: (viewId: string) => string[]): SearchHit[] {
  if (parsed.layouts.length === 0 && parsed.tags.length === 0) return hits;
  return hits.filter((h) => {
    if (parsed.layouts.length > 0 && !parsed.layouts.includes(h.layout)) return false;
    if (parsed.tags.length > 0 && !parsed.tags.every((tag) => tagsOf(h.view_id).includes(tag))) return false;
    return true;
  });
}

export const searchApi = {
  /**
   * 搜索当前空间：Rust 侧一次返回 FTS 命中（文档正文/标题）+ 无文档行的视图标题 LIKE 兜底
   * + 短查询（有词不足 3 字）的正文 LIKE 兜底。
   * 这里只做 <em> 清洗、本地标题命中合并与标题优先排序，最多 100+50+50 条。
   *
   * localViews 传入当前空间的全部视图（不含回收站）：标题与拼音首字母命中由本地即时算出并合并，
   * 不与 FTS 重复（FTS trigram 只按字面匹配，覆盖不到「输入 bj 命中 笔记」这类拼音检索）。
   * 拼音按每个关键词单独展开，多词查询里「笔记 数据库」两词都能各自靠首字母召回标题。
   *
   * 关键词语法（与 Rust db::search 同一套）：空格分词=AND、`"精确短语"`、`-词` 排除；
   * 限定符 `type:`/`tag:` 从输入里剥离后再检索，最后按命中视图的布局/标签过滤；
   * 只输限定符不带关键词时，直接本地列出满足条件的视图（不做正文检索）。
   * 只有排除项（如 `-笔记`）时返回空：FTS5 不接受裸 NOT，也没有正向词可用来兜底，
   * UI 侧走既有的「没有匹配结果」提示。
   */
  async search(workspaceId: string, input: string, localViews: View[] = []): Promise<SearchHit[]> {
    const parsed = parseSearchQuery(input);
    const hasQualifier = parsed.layouts.length > 0 || parsed.tags.length > 0;
    if (parsed.terms.length === 0) {
      // 没有正向关键词：有限定符就本地列举，只有排除项则无从检索（FTS5 不支持裸 NOT）
      if (!hasQualifier) return [];
      return prioritizeSearchRows(localQualifierHits(localViews, parsed), parsed.terms);
    }

    const rows = await invoke<SearchRow[]>("search", { workspaceId, query: parsed.text });
    const cleaned = rows.map((r) => ({ ...r, snippet: sanitizeSnippet(r.snippet) }));
    const merged = mergeSearchRows(cleaned, localTitleHits(localViews, parsed.terms, parsed.exclude), parsed.terms);
    if (!hasQualifier) return merged;
    const byId = new Map(localViews.map((v) => [v.id, v]));
    const tagsOf = (id: string) => parseViewTags(byId.get(id)?.tags).map((x) => x.toLowerCase());
    return filterHits(merged, parsed, tagsOf);
  },
};
