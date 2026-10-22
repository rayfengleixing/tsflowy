// 检索词法（转义 / 切分 / MATCH 与 LIKE 构造）在 terms.rs，本文件只管「怎么把一次查询跑出来」：
// FTS 主路、LIKE 兜底、页面别名三路合并，以及 AI 上下文用的单篇片段检索。
// rusqlite / models / dberr 等共用导入由父模块的 use 继承，这里用 super::* 取。
use super::*;

/// 回收站里的行不该被搜到。行 id 表达式为 NULL（文档命中）时不加条件；
/// 数据库命中要按 row_id 反查行的 is_trash——database_fts 由单元格触发器维护，
/// 软删行只是打标记（单元格还在，为了能从回收站恢复），所以过滤只能放在查询侧。
fn row_trash_filter(row_id_expr: &str) -> String {
    if row_id_expr == "NULL" {
        String::new()
    } else {
        format!(" AND NOT EXISTS (SELECT 1 FROM database_rows dr WHERE dr.id = {row_id_expr} AND dr.is_trash = 1)")
    }
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
         WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND {table} MATCH ?2{trash}
         ORDER BY bm25({table}) LIMIT 100",
        col = snippet_col,
        row_id = row_id_expr,
        trash = row_trash_filter(row_id_expr)
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
// LIKE 兜底的过滤条件被 tests::terms 复用（词法层断言它的拼串），故对 search 模块可见。
pub(super) fn like_filters(text_expr: &str, terms: &[QueryTerm]) -> (String, Vec<String>) {
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
         WHERE v.is_trash = 0 AND v.workspace_id = ?1{filter}{trash}
         LIMIT 50",
        row_id = row_id_expr,
        trash = row_trash_filter(row_id_expr)
    );
    query_rows(conn, &sql, workspace_id, &patterns, "search fallback")
}

/// 别名命中：页面还有别的叫法时（frontmatter 的 aliases / 别名面板），按别名也能把这页搜出来。
/// snippet 直接用命中的那条别名，让结果页能说清「为什么这页会出现在这里」（它的标题里并没有查询词）。
///
/// 逐条别名比对，所以多词查询要求这些词都落在同一条别名里——两个别名各含一个词不算命中，
/// 那种组合在页面上没有任何一个名字对应用户的意图，搜出来只会是噪音。
fn alias_rows(
    conn: &Connection,
    workspace_id: &str,
    terms: &[QueryTerm],
) -> Result<Vec<SearchRowOut>, String> {
    let (filter, patterns) = like_filters("a.value", terms);
    // CASE 兜住历史/同步来的脏值：json_each() 遇到非数组（'x'、3）是运行期报错，
    // 而一次搜索报错会让整个搜索框不可用，比少召回几条别名严重得多
    let sql = format!(
        "SELECT v.id AS view_id, v.name AS title, v.icon, v.layout,
                a.value AS snippet, NULL AS row_id, 1e9 AS rank
         FROM views v, json_each(CASE WHEN json_valid(v.aliases) AND json_type(v.aliases) = 'array'
                                      THEN v.aliases ELSE '[]' END) a
         WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND v.source_id IS NULL{filter}
         LIMIT 50"
    );
    query_rows(conn, &sql, workspace_id, &patterns, "search alias")
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

/// 搜索当前空间，五路合并：文档 FTS（正文/标题）→ 数据库单元格 FTS → 页面别名 →
/// 无索引行的视图标题 LIKE 兜底 → 短查询（有词不足 3 字，trigram 必空）的文档正文与单元格文本 LIKE 兜底。
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
    rows.extend(alias_rows(conn, workspace_id, &terms)?);
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
