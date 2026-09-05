import type { LayoutType } from "@/types/models";
import { invoke } from "@tauri-apps/api/core";

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
}

interface SearchRow extends SearchHit {
  rank: number;
}

/** 标题匹配层级：0 精确 = 1 前缀 = 2 包含 = 3 仅正文命中 */
export function titleTier(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.trim().toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return 3;
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
   * 搜索当前空间：Rust 侧一次返回 FTS 命中（文档正文/标题）+ 无文档行的视图标题 LIKE 兜底。
   * 这里只做 <em> 清洗与标题优先排序，最多 100+50 条。
   */
  async search(workspaceId: string, input: string): Promise<SearchHit[]> {
    const q = input.trim();
    if (!q) return [];
    const rows = await invoke<SearchRow[]>("search", { workspaceId, query: q });
    return prioritizeSearchRows(
      rows.map((r) => ({ ...r, snippet: sanitizeSnippet(r.snippet) })),
      q,
    );
  },
};
