// 词法层的用例：转义、切分、MATCH / LIKE 构造（原 tests 模块 457..580 行，断言未改）。
// like_filters 拼的是词法项、实现在 query.rs，pub(super) 项要靠 glob 的 pub use 透出不了，故显式引入。
use super::super::query::like_filters;
use super::*;

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
