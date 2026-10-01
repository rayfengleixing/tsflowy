import type { LayoutType, View } from "@/types/models";
import { invoke } from "@tauri-apps/api/core";
import { pinyinInitials } from "@/lib/pinyin-initials";

// 全文搜索（项目说明书 12 节风险 1：FTS5 trigram 支持中文子串检索）。
// 结果排序为纯函数，便于 Vitest 单测；DB 访问集中在 searchApi。
// Phase B：FTS 转义（escapeFts/likePattern）与两条查询已下沉 Rust（db::search），
// JS 侧保留 trim/空查询短路、<em> 清洗与标题分层排序。

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

/** 仅标题/拼音可确定的命中（不做正文检索）：本地即时补全命令面板与结果页用 */
export function localTitleHits(views: View[], query: string): SearchRow[] {
  const q = query.trim();
  if (!q) return [];
  return views
    .filter((v) => titleTier(v.name, q) < TIER_BODY_ONLY)
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
export function mergeSearchRows(fts: SearchRow[], local: SearchRow[], query: string): SearchHit[] {
  const seen = new Set(fts.map((r) => r.view_id));
  return prioritizeSearchRows([...fts, ...local.filter((r) => !seen.has(r.view_id))], query);
}

/** 标题优先、同层按 FTS rank 升序 */
export function prioritizeSearchRows(rows: SearchRow[], query: string): SearchHit[] {
  return [...rows]
    .sort((a, b) => {
      const ta = titleTier(a.title, query);
      const tb = titleTier(b.title, query);
      if (ta !== tb) return ta - tb;
      return a.rank - b.rank;
    })
    .map(({ rank: _rank, ...hit }) => hit);
}

/** 片段防注入：只保留 <em>/</em>，其余标签一律剥掉 */
export function sanitizeSnippet(snippet: string): string {
  return snippet.replace(/<(?!\/?em>)[^>]*>/g, "");
}

export const searchApi = {
  /**
   * 搜索当前空间：Rust 侧一次返回 FTS 命中（文档正文/标题）+ 无文档行的视图标题 LIKE 兜底
   * + 短查询（<3 字）的正文 LIKE 兜底。
   * 这里只做 <em> 清洗、本地标题命中合并与标题优先排序，最多 100+50+50 条。
   *
   * localViews 传入当前空间的全部视图（不含回收站）：标题与拼音首字母命中由本地即时算出并合并，
   * 不与 FTS 重复（FTS trigram 只按字面匹配，覆盖不到「输入 bj 命中 笔记」这类拼音检索）。
   */
  async search(workspaceId: string, input: string, localViews: View[] = []): Promise<SearchHit[]> {
    const q = input.trim();
    if (!q) return [];
    const rows = await invoke<SearchRow[]>("search", { workspaceId, query: q });
    const cleaned = rows.map((r) => ({ ...r, snippet: sanitizeSnippet(r.snippet) }));
    return mergeSearchRows(cleaned, localTitleHits(localViews, q), q);
  },
};
