// 查询层的用例：五路合并、别名、兜底与 AI 上下文片段（原 tests 模块 581..999 行，断言未改）。
use super::*;

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

// --- 页面别名（views.aliases）：用另一个叫法也搜得到这一页 ---

fn seed_aliases(conn: &Connection, id: &str, json: &str) {
    conn.execute(
        "UPDATE views SET aliases = ?1 WHERE id = ?2",
        params![json, id],
    )
    .unwrap();
}

#[test]
fn search_finds_page_by_alias() {
    let conn = setup();
    seed_bare_view(&conn, "v1", "项目计划书");
    seed_bare_view(&conn, "v2", "会议记录");
    seed_aliases(&conn, "v1", r#"["立项材料","Proposal"]"#);

    let hits = search(&conn, "w1", "立项材料").unwrap();

    assert_eq!(hits.len(), 1, "标题里没有的词，靠别名召回");
    assert_eq!(hits[0].view_id, "v1");
    // 片段回显命中的那条别名：结果页要能说明「这页标题里没这词，为什么出现」
    assert_eq!(hits[0].snippet, "立项材料");
    assert_eq!(hits[0].rank, 1e9);
}

#[test]
fn search_alias_ignores_ascii_case() {
    let conn = setup();
    seed_bare_view(&conn, "v1", "项目计划书");
    seed_aliases(&conn, "v1", r#"["Proposal Doc"]"#);
    assert_eq!(search(&conn, "w1", "proposal").unwrap().len(), 1);
}

#[test]
fn search_alias_requires_all_terms_inside_one_alias() {
    let conn = setup();
    seed_bare_view(&conn, "v1", "项目计划书");
    seed_aliases(&conn, "v1", r#"["季度 预算","会议纪要"]"#);

    assert_eq!(search(&conn, "w1", "季度 预算").unwrap().len(), 1);
    assert!(
        search(&conn, "w1", "季度 会议").unwrap().is_empty(),
        "两个词拆在两条别名里，页面上没有任何一个名字对得上这个查询"
    );
}

#[test]
fn search_alias_skips_trashed_and_derived_views() {
    let conn = setup();
    seed_bare_view(&conn, "v1", "表A");
    seed_aliases(&conn, "v1", r#"["代号甲"]"#);
    conn.execute("UPDATE views SET is_trash = 1 WHERE id = 'v1'", [])
        .unwrap();
    conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at, source_id, aliases)
             VALUES ('v2', 'w1', '派生视图', 'grid', '{}', 0, 1, 1, 'v1', '[\"代号甲\"]')",
            [],
        )
        .unwrap();

    assert!(search(&conn, "w1", "代号甲").unwrap().is_empty());
}

#[test]
fn search_survives_corrupt_aliases_values() {
    let conn = setup();
    seed_bare_view(&conn, "v1", "坏别名");
    conn.execute("UPDATE views SET aliases = 'not json' WHERE id='v1'", [])
        .unwrap();
    seed_bare_view(&conn, "v2", "另一页");
    seed_aliases(&conn, "v2", "3"); // 合法 JSON，但不是数组：json_each 会直接报错

    let hits = search(&conn, "w1", "别名").unwrap();

    assert_eq!(hits.len(), 1, "脏 aliases 不能把整次搜索打成错误");
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
