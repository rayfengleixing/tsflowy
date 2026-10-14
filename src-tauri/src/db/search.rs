use std::collections::HashSet;

use rusqlite::{params, types::ToSql, Connection};

use super::dberr;
use super::models::SearchRowOut;

/// 单个词/精确短语的 FTS5 转义：包成短语查询，内部双引号翻倍，杜绝语法错误/注入，
/// 也让 `AND`/`NOT`/`*` 这类操作符按字面匹配（多词 AND 与排除由 parse_query_terms 表达）。
/// （原 search.ts escapeFts，下沉到 Rust——JS 侧不再持有）。
pub fn escape_fts(input: &str) -> String {
    format!("\"{}\"", input.replace('"', "\"\""))
}

/// 解析后的一个检索项：`text` 是去引号的词或短语，`excluded` 来自 `-` 前缀。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueryTerm {
    pub text: String,
    pub excluded: bool,
}

/// 把关键词串切成检索项：空白分词，`"..."` 为精确短语，`-` 前缀为排除项。
///
/// 每个词独立成项（拼起来由 fts_expr 用 AND 连接），否则「项目 计划」会被当成一个短语，
/// 命中不了两词分散的文档。引号内不再嵌套引号：遇到下一个 `"` 即结束（未闭合则到结尾），
/// 与 JS 侧 parseSearchQuery 的切分规则一致。
pub(crate) fn parse_query_terms(input: &str) -> Vec<QueryTerm> {
    let chars: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        // `-词` / `-"短语"`：单独一个 `-`（后面紧跟空白）不是项，直接丢弃
        let excluded = chars[i] == '-';
        if excluded {
            i += 1;
        }
        let quoted = i < chars.len() && chars[i] == '"';
        if quoted {
            i += 1;
        }
        let start = i;
        while i < chars.len() {
            let c = chars[i];
            if quoted {
                if c == '"' {
                    break;
                }
            } else if c.is_whitespace() || c == '"' {
                break;
            }
            i += 1;
        }
        let text: String = chars[start..i].iter().collect();
        if quoted && i < chars.len() {
            i += 1; // 跳过闭合引号
        }
        if !text.is_empty() {
            out.push(QueryTerm { text, excluded });
        }
    }
    out
}

/// 检索项里的正向词（排除项之外的部分），供兜底与短路判断复用。
pub(crate) fn positive_terms(terms: &[QueryTerm]) -> Vec<&str> {
    terms
        .iter()
        .filter(|t| !t.excluded)
        .map(|t| t.text.as_str())
        .collect()
}

/// 由检索项拼 FTS5 的 MATCH 表达式：正向项 AND 组合，排除项逐个 NOT 上去。
///
/// 括号是必须的：FTS5 的 `NOT` 右结合，`a AND b NOT c` 会被解析成 `a AND (b NOT c)`，
/// 与「先求交再排除」的意图不同。
/// 返回 None 表示没有正向项——FTS5 不接受整条查询只有排除项（裸 NOT 是语法错误）。
pub(crate) fn fts_expr(terms: &[QueryTerm]) -> Option<String> {
    let positive: Vec<String> = positive_terms(terms).into_iter().map(escape_fts).collect();
    if positive.is_empty() {
        return None;
    }
    let mut expr = positive.join(" AND ");
    for t in terms.iter().filter(|t| t.excluded) {
        expr = format!("({expr}) NOT ({})", escape_fts(&t.text));
    }
    Some(expr)
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

/// 对某张 FTS5 表跑一次检索。table/snippet_col/row_id_expr 只接受调用方写死的常量，
/// 不来自用户输入（FTS5 表不能加别名，所以表名要拼进 SQL）。
fn fts_rows(
    conn: &Connection,
    table: &str,
    snippet_col: i32,
    row_id_expr: &str,
    workspace_id: &str,
    match_expr: &str,
) -> Result<Vec<SearchRowOut>, String> {
    let sql = format!(
        "SELECT {table}.view_id, v.name AS title, v.icon, v.layout,
                snippet({table}, {col}, '<em>', '</em>', '…', 30) AS snippet,
                {row_id} AS row_id,
                bm25({table}) AS rank
         FROM {table}
         JOIN views v ON v.id = {table}.view_id
         WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND {table} MATCH ?2
         ORDER BY bm25({table}) LIMIT 100",
        col = snippet_col,
        row_id = row_id_expr
    );
    query_rows(
        conn,
        &sql,
        workspace_id,
        &[match_expr.to_string()],
        "search fts",
    )
}

/// 兜底 LIKE 的过滤条件：正向项 AND，排除项 NOT LIKE，与 fts_expr 的语义对齐。
/// 返回 (SQL 片段, 与片段里 ?N 同序的模式串)；?1 留给 workspace_id，条件从 ?2 起编号。
fn like_filters(text_expr: &str, terms: &[QueryTerm]) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut patterns = Vec::new();
    for (i, t) in terms.iter().enumerate() {
        let op = if t.excluded { "NOT LIKE" } else { "LIKE" };
        sql.push_str(&format!(" AND ({text_expr}) {op} ?{} ESCAPE '\\'", i + 2));
        patterns.push(like_pattern(&t.text));
    }
    (sql, patterns)
}

/// LIKE 兜底通用形态：snippet 空、rank 固定 1e9（排序交给 JS，兜底只保证"能搜到"）。
/// from/id_expr/text_expr/row_id_expr 由调用方给死，三路兜底各有自己的表别名。
fn like_rows(
    conn: &Connection,
    from: &str,
    id_expr: &str,
    text_expr: &str,
    row_id_expr: &str,
    workspace_id: &str,
    terms: &[QueryTerm],
) -> Result<Vec<SearchRowOut>, String> {
    let (filter, patterns) = like_filters(text_expr, terms);
    let sql = format!(
        "SELECT {id_expr} AS view_id, v.name AS title, v.icon, v.layout,
                '' AS snippet, {row_id} AS row_id, 1e9 AS rank
         FROM {from}
         JOIN views v ON v.id = {id_expr}
         WHERE v.is_trash = 0 AND v.workspace_id = ?1{filter}
         LIMIT 50",
        row_id = row_id_expr
    );
    query_rows(conn, &sql, workspace_id, &patterns, "search fallback")
}

/// 命中行按固定列序取：0 view_id / 1 title / 2 icon / 3 layout / 4 snippet / 5 row_id / 6 rank
/// patterns 依次绑定 SQL 里的 ?2、?3……（多词兜底的项数随查询变化，占位符只能动态生成）
fn query_rows(
    conn: &Connection,
    sql: &str,
    workspace_id: &str,
    patterns: &[String],
    what: &'static str,
) -> Result<Vec<SearchRowOut>, String> {
    let mut stmt = conn.prepare(sql).map_err(dberr(what))?;
    let args: Vec<&dyn ToSql> = std::iter::once(&workspace_id as &dyn ToSql)
        .chain(patterns.iter().map(|p| p as &dyn ToSql))
        .collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok(SearchRowOut {
                view_id: r.get(0)?,
                title: r.get(1)?,
                icon: r.get(2)?,
                layout: r.get(3)?,
                snippet: r.get(4)?,
                row_id: r.get(5)?,
                rank: r.get(6)?,
            })
        })
        .map_err(dberr(what))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr(what))?;
    Ok(rows)
}

/// 搜索当前空间，四路合并：文档 FTS（正文/标题）→ 数据库单元格 FTS → 无索引行的视图标题
/// LIKE 兜底 → 短查询（有词不足 3 字，trigram 必空）的文档正文与单元格文本 LIKE 兜底。
/// 关键词按「每词独立、AND 组合」检索，`"..."` 为精确短语，`-` 前缀排除，四路都遵守。
/// 返回按"FTS 在前、兜底在后"的原始序列；跨路去重按 view_id 保留首条（rank 更小的那条），
/// 标题分层排序与 <em> 清洗仍在 JS（search.ts）。
///
/// 注意1：FTS5 MATCH 只接受位置参数（? / ?N），$N 编号参数会得到空串导致语法错误
/// 注意2：FTS5 表不能加别名（MATCH/snippet/bm25 都无法解析别名），须用全名引用
pub fn search(
    conn: &Connection,
    workspace_id: &str,
    raw_query: &str,
) -> Result<Vec<SearchRowOut>, String> {
    let terms = parse_query_terms(raw_query);
    // 只有排除项时 FTS5 无法表达（不支持裸 NOT），兜底 LIKE 也没有正向词可依：给空结果
    let Some(expr) = fts_expr(&terms) else {
        return Ok(Vec::new());
    };
    let positive = positive_terms(&terms);
    let (title_filter, title_patterns) = like_filters("v.name", &terms);

    let mut rows = fts_rows(conn, "documents_fts", 2, "NULL", workspace_id, &expr)?;
    rows.extend(fts_rows(
        conn,
        "database_fts",
        3,
        "database_fts.row_id",
        workspace_id,
        &expr,
    )?);

    // 标题兜底只服务"完全没有索引行"的视图（空文件夹、空表）
    rows.extend(query_rows(
        conn,
        &format!(
            "SELECT v.id AS view_id, v.name AS title, v.icon, v.layout,
                    '' AS snippet, NULL AS row_id, 1e9 AS rank
             FROM views v
             WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND v.source_id IS NULL{title_filter}
               AND NOT EXISTS (SELECT 1 FROM documents_fts f WHERE f.view_id = v.id)
             LIMIT 50"
        ),
        workspace_id,
        &title_patterns,
        "search title fallback",
    )?);

    if positive.iter().any(|t| t.chars().count() < 3) {
        // 纯文本走 document_text 派生视图（与 FTS 索引同源），不用 documents.content 原文，
        // 否则 JSON 结构字符（`{"type":` 等）也会参与 LIKE 命中
        rows.extend(like_rows(
            conn,
            "documents d JOIN document_text dt ON dt.view_id = d.view_id",
            "d.view_id",
            "dt.txt",
            "NULL",
            workspace_id,
            &terms,
        )?);
        // 走视图现算而非 database_fts：兜底要的是解析后的显示文本，且不受索引滞后影响
        rows.extend(like_rows(
            conn,
            "database_cell_text t",
            "t.view_id",
            "t.txt",
            "t.row_id",
            workspace_id,
            &terms,
        )?);
    }

    Ok(dedupe_by_view(rows))
}

/// 从自然语言问题里切出 FTS5 可命中的关键词。
///
/// documents_fts 用 trigram 分词，1–2 字的词匹配不到、整句短语又几乎不可能命中，
/// 因此对中文串切 3 字滑窗、对英数串按空白/标点切词，再用 OR 组合交给 bm25 排序。
pub(crate) fn keywords(query: &str, max: usize) -> Vec<String> {
    const SEPARATORS: &[char] = &[
        ' ', '\t', '\n', '\r', '，', '。', '！', '？', '；', '：', '、', '（', '）', '《', '》',
        '“', '”', '‘', '’', ',', '.', '!', '?', ';', ':', '(', ')', '[', ']', '{', '}', '/', '-',
    ];
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for token in query.split(|c| SEPARATORS.contains(&c)) {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        let chars: Vec<char> = t.chars().collect();
        let ascii = chars.iter().all(|c| c.is_ascii_alphanumeric() || *c == '_');
        if ascii {
            if chars.len() >= 2 && seen.insert(t.to_ascii_lowercase()) {
                out.push(t.to_string());
            }
        } else if chars.len() <= 3 {
            if chars.len() >= 2 && seen.insert(t.to_string()) {
                out.push(t.to_string());
            }
        } else {
            // 3 字滑窗：与 trigram 索引同宽，命中率最高
            for w in chars.windows(3) {
                let s: String = w.iter().collect();
                if seen.insert(s.clone()) {
                    out.push(s);
                }
                if out.len() >= max {
                    break;
                }
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out.truncate(max);
    out
}

/// 把关键词拼成 FTS5 的 MATCH 表达式：`"词一" OR "词二"`（每个词已按短语转义）
pub(crate) fn match_expr(words: &[String]) -> String {
    words
        .iter()
        .map(|w| escape_fts(w))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// 在单篇文档内检索与查询词相关的片段（AI @ 引用的上下文用）。
///
/// 与全局 search 的区别：只看这一篇，返回可直接拼进 prompt 的纯文本片段（不含 <em> 标记）。
/// 命中为空（查询太短或文档没索引）时返回空数组，由调用方回退到整篇截断。
pub fn search_in_view(
    conn: &Connection,
    view_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let words = keywords(query, 24);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    // 片段取 ±48 个索引 token 的窗口：24 个太碎，模型常拿到半句话猜不到上下文
    let sql = "SELECT snippet(documents_fts, 2, '', '', '…', 48) AS snippet
               FROM documents_fts
               WHERE documents_fts.view_id = ?1 AND documents_fts MATCH ?2
               ORDER BY bm25(documents_fts) LIMIT ?3";
    let mut stmt = conn.prepare(sql).map_err(dberr("search in view"))?;
    let rows = stmt
        .query_map(params![view_id, match_expr(&words), limit as i64], |r| {
            r.get::<_, String>(0)
        })
        .map_err(dberr("search in view"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("search in view"))?;
    Ok(rows)
}

/// 同一视图可能有多条命中（一张表里多个单元格、FTS 与兜底重复），保留先出现的一条。
fn dedupe_by_view(rows: Vec<SearchRowOut>) -> Vec<SearchRowOut> {
    let mut seen: HashSet<String> = HashSet::with_capacity(rows.len());
    rows.into_iter()
        .filter(|r| seen.insert(r.view_id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        // 迁移里的 PRAGMA foreign_keys 落在事务内是空操作；应用连接由 apply_pragmas 打开，
        // 而删行/删字段能否清掉单元格索引取决于级联删除，测试须复现同一状态。
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
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

    // --- 关键词切分与 MATCH 表达式构造 ---

    #[test]
    fn parse_terms_splits_words_into_separate_terms() {
        // 多词不再拼成一个短语：每个词独立成项，由 fts_expr 用 AND 连接
        let t = parse_query_terms("项目 计划");
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].text, "项目");
        assert!(!t[0].excluded);
        assert_eq!(t[1].text, "计划");
    }

    #[test]
    fn parse_terms_keeps_quoted_phrase_as_one_term() {
        let t = parse_query_terms("\"项目 计划\" 笔记");
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].text, "项目 计划");
        assert_eq!(t[1].text, "笔记");
    }

    #[test]
    fn parse_terms_marks_minus_prefixed_as_excluded() {
        let t = parse_query_terms("项目 -计划 -\"营收 报告\"");
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].text, "项目");
        assert!(!t[0].excluded);
        assert_eq!(t[1].text, "计划");
        assert!(t[1].excluded);
        assert_eq!(t[2].text, "营收 报告");
        assert!(t[2].excluded);
    }

    #[test]
    fn parse_terms_tolerates_unbalanced_quote_and_stray_minus() {
        // 未闭合引号读到结尾，仍是一个短语项（与 JS 侧同一套切分规则）
        let t = parse_query_terms("\"笔记");
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].text, "笔记");
        // 单独一个减号后面紧跟空白：不是排除项，后面的词照旧正向
        let t = parse_query_terms("- 笔记");
        assert_eq!(t.len(), 1);
        assert!(!t[0].excluded);
        assert!(parse_query_terms("\"\" -").is_empty());
        assert!(parse_query_terms("   ").is_empty());
    }

    #[test]
    fn fts_expr_ands_positive_terms() {
        assert_eq!(
            fts_expr(&parse_query_terms("项目 计划")).unwrap(),
            "\"项目\" AND \"计划\""
        );
        assert_eq!(fts_expr(&parse_query_terms("项目")).unwrap(), "\"项目\"");
    }

    #[test]
    fn fts_expr_excludes_with_parenthesized_not() {
        // 括号防 FTS5 的 NOT 右结合把 `a AND b NOT c` 变成 `a AND (b NOT c)`
        assert_eq!(
            fts_expr(&parse_query_terms("项目 -营收")).unwrap(),
            "(\"项目\") NOT (\"营收\")"
        );
        assert_eq!(
            fts_expr(&parse_query_terms("甲 乙 -丙 -\"丁 戊\"")).unwrap(),
            "((\"甲\" AND \"乙\") NOT (\"丙\")) NOT (\"丁 戊\")"
        );
    }

    #[test]
    fn fts_expr_refuses_bare_exclusion() {
        // FTS5 没有裸 NOT：只有排除项时表达式无从构造，由调用方给空结果
        assert!(fts_expr(&parse_query_terms("-笔记")).is_none());
        assert!(fts_expr(&[]).is_none());
        assert!(positive_terms(&parse_query_terms("-笔记")).is_empty());
    }

    #[test]
    fn fts_expr_escapes_quotes_inside_term() {
        let terms = vec![QueryTerm {
            text: r#"带"引号 的短语"#.to_string(),
            excluded: false,
        }];
        assert_eq!(fts_expr(&terms).unwrap(), "\"带\"\"引号 的短语\"");
    }

    #[test]
    fn like_filters_ands_terms_and_excludes() {
        let (sql, pats) = like_filters("dt.txt", &parse_query_terms("项目 -营收"));
        assert_eq!(
            sql,
            " AND (dt.txt) LIKE ?2 ESCAPE '\\' AND (dt.txt) NOT LIKE ?3 ESCAPE '\\'"
        );
        assert_eq!(pats, vec!["%项目%".to_string(), "%营收%".to_string()]);
        // 通配符照旧转义成字面量
        let (_, pats) = like_filters("v.name", &parse_query_terms("50%"));
        assert_eq!(pats, vec!["%50\\%%".to_string()]);
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

    // --- AI 上下文检索：单篇文档内的相关片段 ---

    #[test]
    fn keywords_slices_cjk_into_trigrams() {
        let w = keywords("总结这篇文章的核心观点", 24);
        assert!(w.contains(&"总结这".to_string()));
        assert!(w.len() <= 24);
        // 去重：连续滑窗不会把同一个词塞两遍
        let dup = keywords("啊啊啊啊啊", 24);
        assert_eq!(dup.iter().filter(|s| *s == "啊啊啊").count(), 1);
    }

    #[test]
    fn keywords_keeps_ascii_words_and_drops_tiny() {
        let w = keywords("Tell me about Rust tokio", 24);
        assert!(w.contains(&"Rust".to_string()));
        assert!(w.contains(&"tokio".to_string()));
        assert!(keywords("", 24).is_empty());
        // 单字在 trigram 下匹配不到，不进查询
        assert!(keywords("的", 24).is_empty());
    }

    #[test]
    fn match_expr_joins_with_or() {
        assert_eq!(
            match_expr(&["甲乙丙".to_string(), "丙丁戊".to_string()]),
            "\"甲乙丙\" OR \"丙丁戊\""
        );
    }

    #[test]
    fn search_in_view_returns_relevant_snippets() {
        let conn = setup();
        seed_doc_view(
            &conn,
            "v1",
            "周报",
            "本周完成了同步功能的开发，并修复了三处缺陷。下周计划做性能优化。",
        );
        let hits = search_in_view(&conn, "v1", "性能优化", 5).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().any(|s| s.contains("性能优化")));
        // 片段里不带高亮标记：直接拼进 prompt
        assert!(hits.iter().all(|s| !s.contains("<em>")));
    }

    #[test]
    fn search_in_view_scoped_to_one_view() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "甲", "这是一篇关于前端渲染的笔记。");
        seed_doc_view(&conn, "v2", "乙", "这是一篇关于数据库索引的笔记。");
        // 关键词只出现在 v2，查 v1 应当没有命中
        assert!(search_in_view(&conn, "v1", "数据库索引", 5)
            .unwrap()
            .is_empty());
        assert!(!search_in_view(&conn, "v2", "数据库索引", 5)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn search_in_view_empty_query_returns_nothing() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "甲", "内容内容内容");
        assert!(search_in_view(&conn, "v1", "", 5).unwrap().is_empty());
    }

    #[test]
    fn body_hit_returns_snippet_with_em() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"今天天气不错适合散步"}"#);
        let hits = search(&conn, "w1", "天气不错").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
        assert!(
            hits[0].snippet.contains("<em>天气不错</em>"),
            "{}",
            hits[0].snippet
        );
        assert!(hits[0].rank < 1e9);
        assert_eq!(hits[0].row_id, None, "文档命中不该带行 id");
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
    fn multi_word_query_matches_documents_with_words_apart() {
        let conn = setup();
        // 原缺陷：整句包成一个 FTS 短语，两个词分散在正文不同位置就什么都搜不到
        seed_doc_view(
            &conn,
            "v1",
            "标题A",
            r#"{"text":"这里写着项目计划四个字，另有营收报告一段"}"#,
        );
        seed_doc_view(
            &conn,
            "v2",
            "标题B",
            r#"{"text":"只有项目计划，别的一样没有"}"#,
        );
        let hits = search(&conn, "w1", "项目计划 营收报告").unwrap();
        assert_eq!(hits.len(), 1, "多词是 AND：两个词都在的文档才命中");
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn quoted_phrase_requires_the_words_to_be_adjacent() {
        let conn = setup();
        seed_doc_view(
            &conn,
            "v1",
            "标题A",
            r#"{"text":"讨论 项目计划 营收报告 的细节"}"#,
        );
        seed_doc_view(
            &conn,
            "v2",
            "标题B",
            r#"{"text":"项目计划写在前面，营收报告附在后面"}"#,
        );
        let loose = search(&conn, "w1", "项目计划 营收报告").unwrap();
        assert_eq!(loose.len(), 2, "不加引号：两词分散也命中");
        let strict = search(&conn, "w1", r#""项目计划 营收报告""#).unwrap();
        assert_eq!(strict.len(), 1, "加引号：必须按精确短语匹配");
        assert_eq!(strict[0].view_id, "v1");
    }

    #[test]
    fn excluded_term_drops_documents_containing_it() {
        let conn = setup();
        seed_doc_view(
            &conn,
            "v1",
            "标题A",
            r#"{"text":"项目计划里包含营收报告的截图"}"#,
        );
        seed_doc_view(
            &conn,
            "v2",
            "标题B",
            r#"{"text":"项目计划只有一份，其余都是空白"}"#,
        );
        let hits = search(&conn, "w1", "项目计划 -营收报告").unwrap();
        assert_eq!(hits.len(), 1, "排除项命中即出局");
        assert_eq!(hits[0].view_id, "v2");
    }

    #[test]
    fn exclusion_only_query_returns_no_rows() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"项目计划的内容"}"#);
        seed_bare_view(&conn, "v2", "项目计划表");
        // FTS5 不接受裸 NOT，兜底 LIKE 也没有正向词可依：空结果，不能退化成全库
        assert!(search(&conn, "w1", "-项目计划").unwrap().is_empty());
        assert!(search(&conn, "w1", r#"-"项目 计划""#).unwrap().is_empty());
    }

    #[test]
    fn title_fallback_requires_every_positive_term() {
        let conn = setup();
        seed_bare_view(&conn, "v1", "项目计划营收报告汇总");
        seed_bare_view(&conn, "v2", "项目计划表");
        let hits = search(&conn, "w1", "项目计划 营收报告").unwrap();
        assert_eq!(hits.len(), 1, "标题兜底也要按 AND 过滤");
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn title_fallback_honours_excluded_term() {
        let conn = setup();
        seed_bare_view(&conn, "v1", "项目计划含营收报告");
        seed_bare_view(&conn, "v2", "项目计划不含别的");
        let hits = search(&conn, "w1", "项目计划 -营收报告").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v2");
    }

    #[test]
    fn short_query_content_fallback_ands_every_term() {
        let conn = setup();
        seed_doc_view(&conn, "v1", "标题A", r#"{"text":"今天天气不错"}"#);
        seed_doc_view(&conn, "v2", "标题B", r#"{"text":"下雪之前天气转凉"}"#);
        let hits = search(&conn, "w1", "天气 雪").unwrap();
        assert_eq!(
            hits.len(),
            1,
            "短查询兜底同样按 AND：只有一词的文档不算命中"
        );
        assert_eq!(hits[0].view_id, "v2");
    }

    #[test]
    fn quoted_phrase_with_operator_looking_text_matched_literally() {
        let conn = setup();
        seed_doc_view(
            &conn,
            "v1",
            "标题A",
            r#"{"text":"a OR b 真的出现在内容里"}"#,
        );
        seed_doc_view(&conn, "v2", "标题B", r#"{"text":"完全无关的另一段文字"}"#);
        // 引号里的 OR 是字面量：整个短语按子串匹配
        let hits = search(&conn, "w1", r#""a OR b""#).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
    }

    #[test]
    fn operator_looking_words_without_quotes_are_anded() {
        let conn = setup();
        seed_doc_view(
            &conn,
            "v1",
            "标题A",
            r#"{"text":"a OR b 真的出现在内容里"}"#,
        );
        seed_doc_view(&conn, "v2", "标题B", r#"{"text":"完全无关的另一段文字"}"#);
        // 不带引号时不再是「整串子串」也不是布尔表达式，而是 a AND OR AND b（短词走 LIKE 兜底）
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
        assert_eq!(hits[0].row_id, None);
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

    // --- 数据库单元格（迁移 008）---

    fn seed_db_view(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', NULL, ?2, 'grid', '{}', 0, 1, 1)",
            params![id, name],
        )
        .unwrap();
    }

    fn seed_field(conn: &Connection, id: &str, db: &str, name: &str, ftype: &str, options: &str) {
        conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES (?1, ?2, ?3, ?4, ?5, 180, 0, 0)",
            params![id, db, name, ftype, options],
        )
        .unwrap();
    }

    fn seed_row(conn: &Connection, id: &str, db: &str) {
        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at)
             VALUES (?1, ?2, 0, 1, 1)",
            params![id, db],
        )
        .unwrap();
    }

    fn seed_cell(conn: &Connection, row: &str, field: &str, value: &str) {
        conn.execute(
            "INSERT INTO database_cells(row_id, field_id, value) VALUES (?1, ?2, ?3)",
            params![row, field, value],
        )
        .unwrap();
    }

    /// 一张带 text 字段的表：v1 表 + f1 字段 + r1 行，单元格值为 value
    fn seed_one_cell_table(conn: &Connection, value: &str) {
        seed_db_view(conn, "v1", "项目表");
        seed_field(conn, "f1", "v1", "标题", "text", "{}");
        seed_row(conn, "r1", "v1");
        seed_cell(conn, "r1", "f1", value);
    }

    #[test]
    fn cell_hit_returns_database_page_with_snippet() {
        let conn = setup();
        seed_one_cell_table(&conn, r#""季度营收报告""#);
        let hits = search(&conn, "w1", "营收报告").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
        assert_eq!(hits[0].layout, "grid");
        assert!(
            hits[0].snippet.contains("<em>营收报告</em>"),
            "{}",
            hits[0].snippet
        );
        assert!(hits[0].rank < 1e9);
        assert_eq!(
            hits[0].row_id.as_deref(),
            Some("r1"),
            "单元格命中必须带行 id，供页面定位"
        );
    }

    #[test]
    fn several_matching_cells_collapse_to_one_hit() {
        let conn = setup();
        seed_db_view(&conn, "v1", "项目表");
        seed_field(&conn, "f1", "v1", "标题", "text", "{}");
        seed_field(&conn, "f2", "v1", "备注", "text", "{}");
        seed_row(&conn, "r1", "v1");
        seed_row(&conn, "r2", "v1");
        seed_cell(&conn, "r1", "f1", r#""营收表""#);
        seed_cell(&conn, "r2", "f2", r#""营收口径说明""#);
        let hits = search(&conn, "w1", "营收").unwrap();
        assert_eq!(hits.len(), 1, "一张表只出一个命中");
        // 命中多行时保留最相关的那一行，跳转只需要一个落点
        assert!(
            hits[0].row_id.as_deref() == Some("r1") || hits[0].row_id.as_deref() == Some("r2"),
            "{:?}",
            hits[0].row_id
        );
    }

    /// 单选/多选单元格存的是选项 id，能搜到是因为索引前解析成了选项名
    #[test]
    fn select_cells_hit_on_option_name_not_id() {
        let conn = setup();
        let opts = r#"{"kind":"select","options":[{"id":"opt_a","name":"进行中","color":"blue"},{"id":"opt_b","name":"已交付","color":"green"}]}"#;
        seed_db_view(&conn, "v1", "任务表");
        seed_field(&conn, "f1", "v1", "状态", "single_select", opts);
        seed_field(&conn, "f2", "v1", "标签", "multi_select", opts);
        seed_row(&conn, "r1", "v1");
        seed_cell(&conn, "r1", "f1", r#""opt_a""#);
        seed_cell(&conn, "r1", "f2", r#"["opt_a","opt_b"]"#);

        let hits = search(&conn, "w1", "已交付").unwrap();
        assert_eq!(hits.len(), 1, "多选里的选项名必须可搜");
        assert_eq!(hits[0].view_id, "v1");

        let by_id = search(&conn, "w1", "opt_a").unwrap();
        assert_eq!(by_id.len(), 0, "索引里只留用户看得见的名字，id 不进索引");
    }

    #[test]
    fn checkbox_cells_are_not_indexed() {
        let conn = setup();
        seed_db_view(&conn, "v1", "清单");
        seed_field(&conn, "f1", "v1", "完成", "checkbox", "{}");
        seed_row(&conn, "r1", "v1");
        seed_cell(&conn, "r1", "f1", "true");
        // "true"/"1" 不是用户看得见的文字（界面显示 ✓），不该进索引
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fts WHERE content <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn renamed_option_reindexes_cells() {
        let conn = setup();
        let opts = r#"{"kind":"select","options":[{"id":"opt_a","name":"草稿","color":"blue"}]}"#;
        seed_db_view(&conn, "v2", "文档表");
        seed_field(&conn, "f2", "v2", "状态", "single_select", opts);
        seed_row(&conn, "r2", "v2");
        seed_cell(&conn, "r2", "f2", r#""opt_a""#);
        assert_eq!(search(&conn, "w1", "草稿状态").unwrap().len(), 0);

        conn.execute(
            "UPDATE database_fields SET options = ?1 WHERE id = 'f2'",
            [r#"{"kind":"select","options":[{"id":"opt_a","name":"草稿状态","color":"blue"}]}"#],
        )
        .unwrap();
        let hits = search(&conn, "w1", "草稿状态").unwrap();
        assert_eq!(hits.len(), 1, "改选项名后索引必须跟着重建");
        assert_eq!(hits[0].view_id, "v2");
    }

    #[test]
    fn deleted_row_and_field_leave_no_hit() {
        let conn = setup();
        seed_one_cell_table(&conn, r#""季度营收报告""#);
        assert_eq!(search(&conn, "w1", "营收报告").unwrap().len(), 1);

        // 删行：FK 级联删单元格，DELETE 触发器要把索引一起带走
        conn.execute("DELETE FROM database_rows WHERE id = 'r1'", [])
            .unwrap();
        assert!(
            search(&conn, "w1", "营收报告").unwrap().is_empty(),
            "删行后不应残留命中"
        );

        seed_row(&conn, "r1", "v1");
        seed_cell(&conn, "r1", "f1", r#""季度营收报告""#);
        assert_eq!(search(&conn, "w1", "营收报告").unwrap().len(), 1);
        conn.execute("DELETE FROM database_fields WHERE id = 'f1'", [])
            .unwrap();
        assert!(
            search(&conn, "w1", "营收报告").unwrap().is_empty(),
            "删字段后不应残留命中"
        );
    }

    #[test]
    fn trashed_database_page_excluded() {
        let conn = setup();
        seed_one_cell_table(&conn, r#""季度营收报告""#);
        conn.execute("UPDATE views SET is_trash = 1 WHERE id = 'v1'", [])
            .unwrap();
        assert!(search(&conn, "w1", "营收报告").unwrap().is_empty());
    }

    #[test]
    fn timestamp_cells_index_raw_iso_string() {
        let conn = setup();
        // 002 的触发器把时间戳写成裸 ISO 串（不是合法 JSON），按日期检索正好用得上
        seed_db_view(&conn, "v1", "记录表");
        seed_field(&conn, "f1", "v1", "创建于", "created_at", "{}");
        seed_row(&conn, "r1", "v1"); // trg_cells_row_inserted 自动补时间戳单元格
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fts WHERE content LIKE '%T%:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "裸 ISO 时间戳应原样入索引");
    }

    #[test]
    fn short_query_hits_cell_text_via_like() {
        let conn = setup();
        seed_one_cell_table(&conn, r#""季度营收""#);
        let hits = search(&conn, "w1", "营收").unwrap();
        assert_eq!(
            hits.len(),
            1,
            "2 字查询 trigram 索引必空，必须走单元格 LIKE 兜底"
        );
        assert_eq!(hits[0].view_id, "v1");
        assert_eq!(hits[0].rank, 1e9);
        assert_eq!(
            hits[0].row_id.as_deref(),
            Some("r1"),
            "LIKE 兜底同样要能定位到行"
        );
    }

    #[test]
    fn dirty_cell_value_does_not_break_writes() {
        let conn = setup();
        seed_one_cell_table(&conn, "not json at all");
        seed_db_view(&conn, "v2", "另一张表");
        seed_field(&conn, "f2", "v2", "状态", "single_select", "broken options");
        seed_row(&conn, "r2", "v2");
        seed_cell(&conn, "r2", "f2", r#""opt_x""#); // 选项 JSON 非法：解析退回 id
        let hits = search(&conn, "w1", "not json at all").unwrap();
        assert_eq!(hits.len(), 1, "非法 JSON 原样入索引，写入不能失败");
        assert_eq!(hits[0].view_id, "v1");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fts WHERE row_id = 'r2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }
}
