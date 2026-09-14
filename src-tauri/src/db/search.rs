use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::models::SearchRowOut;
use super::dberr;

/// FTS5 查询转义：整体包成短语查询，内部双引号翻倍转义，杜绝语法错误/注入
/// （原 search.ts escapeFts，下沉到 Rust——JS 侧不再持有）。
pub fn escape_fts(input: &str) -> String {
    format!("\"{}\"", input.replace('"', "\"\""))
}

/// SQL LIKE 模式转义（配合 ESCAPE '\'）
/// （原 search.ts likePattern，下沉到 Rust）。
pub fn like_pattern(input: &str) -> String {
    let escaped: String = input
        .chars()
        .map(|c| {
            if c == '\\' || c == '%' || c == '_' {
                format!("\\{c}")
            } else {
                c.to_string()
            }
        })
        .collect();
    format!("%{escaped}%")
}

/// 搜索当前空间：FTS 命中（文档正文/标题）+ 无文档行的视图标题 LIKE 兜底
/// + 短查询（<3 字，trigram 无法命中）的文档正文 LIKE 兜底。
/// 返回 FTS 行在前、兜底行在后的原始序列；标题分层排序与 <em> 清洗仍在 JS（search.ts）。
///
/// 注意1：FTS5 MATCH 只接受位置参数（? / ?N），$N 编号参数会得到空串导致语法错误
/// 注意2：FTS5 表不能加别名（MATCH/snippet/bm25 都无法解析别名），须用全名引用
pub fn search(conn: &Connection, workspace_id: &str, raw_query: &str) -> Result<Vec<SearchRowOut>, String> {
    let q = raw_query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT documents_fts.view_id, v.name AS title, v.icon, v.layout,
                    snippet(documents_fts, 2, '<em>', '</em>', '…', 30) AS snippet,
                    bm25(documents_fts) AS rank
             FROM documents_fts
             JOIN views v ON v.id = documents_fts.view_id
             WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND documents_fts MATCH ?2
             ORDER BY bm25(documents_fts) LIMIT 100",
        )
        .map_err(dberr("search fts"))?;
    let mut rows = stmt
        .query_map(params![workspace_id, escape_fts(q)], |r| {
            Ok(SearchRowOut {
                view_id: r.get(0)?,
                title: r.get(1)?,
                icon: r.get(2)?,
                layout: r.get(3)?,
                snippet: r.get(4)?,
                rank: r.get(5)?,
            })
        })
        .map_err(dberr("search fts"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("search fts"))?;

    let mut stmt = conn
        .prepare(
            "SELECT v.id AS view_id, v.name AS title, v.icon, v.layout,
                    '' AS snippet, 1e9 AS rank
             FROM views v
             WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND v.source_id IS NULL
               AND v.name LIKE ?2 ESCAPE '\\'
               AND NOT EXISTS (SELECT 1 FROM documents_fts f WHERE f.view_id = v.id)
             LIMIT 50",
        )
        .map_err(dberr("search fallback"))?;
    let fallback = stmt
        .query_map(params![workspace_id, like_pattern(q)], |r| {
            Ok(SearchRowOut {
                view_id: r.get(0)?,
                title: r.get(1)?,
                icon: r.get(2)?,
                layout: r.get(3)?,
                snippet: r.get(4)?,
                rank: r.get(5)?,
            })
        })
        .map_err(dberr("search fallback"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("search fallback"))?;

    rows.extend(fallback);

    // trigram 索引最小 token 为 3 字符，1-2 字查询在 FTS 中必空：
    // 再对文档正文做 LIKE 兜底。三路结果理论不相交（标题兜底排除有 FTS 行的视图、
    // 正文兜底要求有 documents 行、FTS 要求 ≥3 字），去重仅作保险。
    if q.chars().count() < 3 {
        let mut stmt = conn
            .prepare(
                "SELECT d.view_id, v.name AS title, v.icon, v.layout,
                        '' AS snippet, 1e9 AS rank
                 FROM documents d
                 JOIN views v ON v.id = d.view_id
                 WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND d.content LIKE ?2 ESCAPE '\\'
                 LIMIT 50",
            )
            .map_err(dberr("search content fallback"))?;
        let content_hits = stmt
            .query_map(params![workspace_id, like_pattern(q)], |r| {
                Ok(SearchRowOut {
                    view_id: r.get(0)?,
                    title: r.get(1)?,
                    icon: r.get(2)?,
                    layout: r.get(3)?,
                    snippet: r.get(4)?,
                    rank: r.get(5)?,
                })
            })
            .map_err(dberr("search content fallback"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(dberr("search content fallback"))?;

        let mut seen: HashSet<String> = rows.iter().map(|r| r.view_id.clone()).collect();
        for hit in content_hits {
            if seen.insert(hit.view_id.clone()) {
                rows.push(hit);
            }
        }
    }

    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn
    }

    fn seed_doc_view(conn: &Connection, id: &str, name: &str, content: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', NULL, ?2, 'document', '{}', 0, 1, 1)",
            params![id, name],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES (?1, ?2, 1)",
            params![id, content],
        )
        .unwrap();
    }

    fn seed_bare_view(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', NULL, ?2, 'document', '{}', 0, 1, 1)",
            params![id, name],
        )
        .unwrap();
    }

    // --- 转义函数：与被删除的 search.test.ts 用例一一对应 ---

    #[test]
    fn escape_fts_wraps_as_phrase() {
        assert_eq!(escape_fts("测试"), "\"测试\"");
        assert_eq!(escape_fts("hello world"), "\"hello world\"");
    }

    #[test]
    fn escape_fts_doubles_inner_quotes() {
        assert_eq!(escape_fts("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn escape_fts_neutralizes_operators() {
        assert_eq!(escape_fts("a OR b AND NOT c"), "\"a OR b AND NOT c\"");
        assert_eq!(escape_fts("foo* -bar"), "\"foo* -bar\"");
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("50%"), "%50\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        assert_eq!(like_pattern("中文"), "%中文%");
    }

    // --- 查询行为 ---

    #[test]
    fn empty_query_returns_nothing() {
        let conn = setup();
        assert!(search(&conn, "w1", "").unwrap().is_empty());
        assert!(search(&conn, "w1", "   ").unwrap().is_empty());
    }

    #[test]
    fn body_hit_returns_snippet_with_em() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"今天天气不错适合散步"}"#);
        let hits = search(&conn, "w1", "天气不错").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
        assert!(hits[0].snippet.contains("<em>天气不错</em>"), "{}", hits[0].snippet);
        assert!(hits[0].rank < 1e9);
    }

    #[test]
    fn quoted_phrase_query_is_no_syntax_error_and_matches() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"他说 "你好" 之后离开"#);
        let hits = search(&conn, "w1", "他说 \"你好\"").unwrap();
        assert_eq!(hits.len(), 1, "带引号短语必须正常匹配，不能报 FTS 语法错误");
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn operator_looking_query_matched_literally() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"a OR b 真的出现在内容里"}"#);
        seed_doc_view(&conn, "v2", "标题B", r#"{"text":"完全无关的另一段文字"}"#);
        // 未转义时 "a OR b" 会被 FTS 解析为布尔表达式；包成短语后按字面子串匹配
        let hits = search(&conn, "w1", "a OR b").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn like_fallback_for_views_without_documents() {
        let conn = setup();
        seed_bare_view(&conn, "v1", "ab"); // 2 字标题：trigram 不入 FTS 匹配范围，走 LIKE
        seed_doc_view(&conn, "v2", "cd", r#"{"text":"无关内容"}"#); // 有文档行 → 被兜底排除
        let hits = search(&conn, "w1", "ab").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
        assert_eq!(hits[0].rank, 1e9);
        assert_eq!(hits[0].snippet, "");
    }

    #[test]
    fn like_fallback_escapes_wildcards() {
        let conn = setup();
        seed_bare_view(&conn, "v1", "50%off");
        seed_bare_view(&conn, "v2", "50xoff");
        let hits = search(&conn, "w1", "50%").unwrap();
        assert_eq!(hits.len(), 1, "LIKE 通配符必须被转义为字面量");
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn other_workspace_rows_excluded() {
        let conn = setup();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w2','W2',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('x', 'w2', NULL, '别名视图xx', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"别名视图xx 的内容"}"#);
        let hits = search(&conn, "w1", "别名视图").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
    }

    // --- 短查询（<3 字）正文 LIKE 兜底：trigram 索引无法命中 ---

    #[test]
    fn short_query_hits_document_content_via_like() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"今天天气不错"}"#);
        let hits = search(&conn, "w1", "天").unwrap();
        assert_eq!(hits.len(), 1, "1 字查询必须走正文 LIKE 兜底命中");
        assert_eq!(hits[0].view_id, "v1");
        assert_eq!(hits[0].snippet, "");
        assert_eq!(hits[0].rank, 1e9);
    }

    #[test]
    fn short_query_content_fallback_escapes_wildcards() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"a%_b 字面量"}"#);
        seed_doc_view(&conn, "v2", "标题B", r#"{"text":"aXYb 无关"}"#);
        let hits = search(&conn, "w1", "%_").unwrap();
        assert_eq!(hits.len(), 1, "LIKE 通配符必须被转义为字面量");
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn short_query_no_dupe_between_fallbacks() {
        let conn = setup();
        seed_bare_view(&conn, "v1", "天"); // 标题兜底命中（无 documents 行）
        seed_doc_view(&conn, "v2", "标题B", r#"{"text":"晴天"}"#); // 正文兜底命中
        let hits = search(&conn, "w1", "天").unwrap();
        assert_eq!(hits.len(), 2);
        let ids: Vec<&str> = hits.iter().map(|h| h.view_id.as_str()).collect();
        assert_eq!(ids, vec!["v1", "v2"]);
    }

    #[test]
    fn content_fallback_excludes_other_workspace() {
        let conn = setup();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w2','W2',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('x', 'w2', NULL, '标题X', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES ('x', '{\"text\":\"雪落无声\"}', 1)",
            [],
        )
        .unwrap();
        let hits = search(&conn, "w1", "雪").unwrap();
        assert!(hits.is_empty(), "其他空间的正文命中必须被排除");
    }
}
