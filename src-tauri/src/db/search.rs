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

/// 对某张 FTS5 表跑一次短语匹配。table/snippet_col/row_id_expr 只接受调用方写死的常量，
/// 不来自用户输入（FTS5 表不能加别名，所以表名要拼进 SQL）。
fn fts_rows(
    conn: &Connection,
    table: &str,
    snippet_col: i32,
    row_id_expr: &str,
    workspace_id: &str,
    q: &str,
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
    query_rows(conn, &sql, workspace_id, &escape_fts(q), "search fts")
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
    like: &str,
) -> Result<Vec<SearchRowOut>, String> {
    let sql = format!(
        "SELECT {id_expr} AS view_id, v.name AS title, v.icon, v.layout,
                '' AS snippet, {row_id} AS row_id, 1e9 AS rank
         FROM {from}
         JOIN views v ON v.id = {id_expr}
         WHERE v.is_trash = 0 AND v.workspace_id = ?1
           AND {text_expr} LIKE ?2 ESCAPE '\\'
         LIMIT 50",
        row_id = row_id_expr
    );
    query_rows(conn, &sql, workspace_id, like, "search fallback")
}

/// 命中行按固定列序取：0 view_id / 1 title / 2 icon / 3 layout / 4 snippet / 5 row_id / 6 rank
fn query_rows(
    conn: &Connection,
    sql: &str,
    workspace_id: &str,
    pattern: &str,
    what: &'static str,
) -> Result<Vec<SearchRowOut>, String> {
    let mut stmt = conn.prepare(sql).map_err(dberr(what))?;
    let rows = stmt
        .query_map(params![workspace_id, pattern], |r| {
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
/// LIKE 兜底 → 短查询（<3 字，trigram 必空）的文档正文与单元格文本 LIKE 兜底。
/// 返回按"FTS 在前、兜底在后"的原始序列；跨路去重按 view_id 保留首条（rank 更小的那条），
/// 标题分层排序与 <em> 清洗仍在 JS（search.ts）。
///
/// 注意1：FTS5 MATCH 只接受位置参数（? / ?N），$N 编号参数会得到空串导致语法错误
/// 注意2：FTS5 表不能加别名（MATCH/snippet/bm25 都无法解析别名），须用全名引用
pub fn search(conn: &Connection, workspace_id: &str, raw_query: &str) -> Result<Vec<SearchRowOut>, String> {
    let q = raw_query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let like = like_pattern(q);

    let mut rows = fts_rows(conn, "documents_fts", 2, "NULL", workspace_id, q)?;
    rows.extend(fts_rows(
        conn,
        "database_fts",
        3,
        "database_fts.row_id",
        workspace_id,
        q,
    )?);

    // 标题兜底只服务"完全没有索引行"的视图（空文件夹、空表）
    rows.extend(query_rows(
        conn,
        "SELECT v.id AS view_id, v.name AS title, v.icon, v.layout,
                '' AS snippet, NULL AS row_id, 1e9 AS rank
         FROM views v
         WHERE v.is_trash = 0 AND v.workspace_id = ?1 AND v.source_id IS NULL
           AND v.name LIKE ?2 ESCAPE '\\'
           AND NOT EXISTS (SELECT 1 FROM documents_fts f WHERE f.view_id = v.id)
         LIMIT 50",
        workspace_id,
        &like,
        "search title fallback",
    )?);

    if q.chars().count() < 3 {
        // 纯文本走 document_text 派生视图（与 FTS 索引同源），不用 documents.content 原文，
        // 否则 JSON 结构字符（`{"type":` 等）也会参与 LIKE 命中
        rows.extend(like_rows(
            conn,
            "documents d JOIN document_text dt ON dt.view_id = d.view_id",
            "d.view_id",
            "dt.txt",
            "NULL",
            workspace_id,
            &like,
        )?);
        // 走视图现算而非 database_fts：兜底要的是解析后的显示文本，且不受索引滞后影响
        rows.extend(like_rows(
            conn,
            "database_cell_text t",
            "t.view_id",
            "t.txt",
            "t.row_id",
            workspace_id,
            &like,
        )?);
    }

    Ok(dedupe_by_view(rows))
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
        assert!(hits[0].snippet.contains("<em>营收报告</em>"), "{}", hits[0].snippet);
        assert!(hits[0].rank < 1e9);
        assert_eq!(hits[0].row_id.as_deref(), Some("r1"), "单元格命中必须带行 id，供页面定位");
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
            .query_row("SELECT COUNT(*) FROM database_fts WHERE content <> ''", [], |r| r.get(0))
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
        conn.execute("DELETE FROM database_rows WHERE id = 'r1'", []).unwrap();
        assert!(search(&conn, "w1", "营收报告").unwrap().is_empty(), "删行后不应残留命中");

        seed_row(&conn, "r1", "v1");
        seed_cell(&conn, "r1", "f1", r#""季度营收报告""#);
        assert_eq!(search(&conn, "w1", "营收报告").unwrap().len(), 1);
        conn.execute("DELETE FROM database_fields WHERE id = 'f1'", []).unwrap();
        assert!(search(&conn, "w1", "营收报告").unwrap().is_empty(), "删字段后不应残留命中");
    }

    #[test]
    fn trashed_database_page_excluded() {
        let conn = setup();
        seed_one_cell_table(&conn, r#""季度营收报告""#);
        conn.execute("UPDATE views SET is_trash = 1 WHERE id = 'v1'", []).unwrap();
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
        assert_eq!(hits.len(), 1, "2 字查询 trigram 索引必空，必须走单元格 LIKE 兜底");
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
            .query_row("SELECT COUNT(*) FROM database_fts WHERE row_id = 'r2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
