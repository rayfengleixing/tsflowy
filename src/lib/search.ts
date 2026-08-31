import type { LayoutType } from "@/types/models";
import { getDb } from "./db";

// 全文搜索（项目说明书 12 节风险 1：FTS5 trigram 支持中文子串检索）。
// 查询构造与结果排序为纯函数，便于 Vitest 单测；DB 访问集中在 searchApi。

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

/** FTS5 查询转义：整体包成短语查询，内部双引号翻倍转义，杜绝语法错误/注入 */
export function escapeFts(input: string): string {
  return '"' + input.replace(/"/g, '""') + '"';
}

/** SQL LIKE 模式转义（配合 ESCAPE '\\'） */
export function likePattern(input: string): string {
  return "%" + input.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
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
   * 搜索当前空间：FTS 命中（文档正文/标题）+ 无文档行的视图标题 LIKE 兜底。
   * 返回标题优先排序的结果，最多 100 条。
   */
  async search(workspaceId: string, input: string): Promise<SearchHit[]> {
    const q = input.trim();
    if (!q) return [];
    const d = await getDb();

    // 注意1：FTS5 MATCH 只接受位置参数（? / ?N），$N 编号参数会得到空串导致语法错误
    // 注意2：FTS5 表不能加别名（MATCH/snippet/bm25 都无法解析别名），须用全名引用
    const rows = await d.select<SearchRow[]>(
      `SELECT documents_fts.view_id, v.name AS title, v.icon, v.layout,
              snippet(documents_fts, 2, '<em>', '</em>', '…', 30) AS snippet,
              bm25(documents_fts) AS rank
       FROM documents_fts
       JOIN views v ON v.id = documents_fts.view_id
       WHERE v.is_trash = 0 AND v.workspace_id = ? AND documents_fts MATCH ?
       ORDER BY bm25(documents_fts) LIMIT 100`,
      [workspaceId, escapeFts(q)],
    );
    const fallback = await d.select<SearchRow[]>(
      `SELECT v.id AS view_id, v.name AS title, v.icon, v.layout,
              '' AS snippet, 1e9 AS rank
       FROM views v
       WHERE v.is_trash = 0 AND v.workspace_id = ? AND v.name LIKE ? ESCAPE '\\'
         AND NOT EXISTS (SELECT 1 FROM documents_fts f WHERE f.view_id = v.id)
       LIMIT 50`,
      [workspaceId, likePattern(q)],
    );
    return prioritizeSearchRows(
      rows.map((r) => ({ ...r, snippet: sanitizeSnippet(r.snippet) })).concat(fallback),
      q,
    );
  },
};