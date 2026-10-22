// 数据库单元格（迁移 008）的用例（原 tests 模块 1000..1256 行，断言未改）。
use super::*;

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

/// 回收站里的行不再可搜：database_fts 由单元格触发器维护，软删不会删索引行，
/// 过滤只能放在检索侧（FTS 与 LIKE 兜底两条路都要挡）。
#[test]
fn trashed_row_is_not_searchable() {
    let conn = setup();
    seed_db_view(&conn, "v1", "项目表");
    seed_field(&conn, "f1", "v1", "标题", "text", "{}");
    seed_row(&conn, "r1", "v1");
    seed_cell(&conn, "r1", "f1", r#""营收口径说明""#);
    assert_eq!(search(&conn, "w1", "营收口径").unwrap().len(), 1);

    crate::db::database::soft_delete_rows(&conn, &["r1".to_string()]).unwrap();

    assert!(
        search(&conn, "w1", "营收口径").unwrap().is_empty(),
        "FTS 路径漏掉了行级回收站过滤"
    );
    assert!(
        search(&conn, "w1", "营收").unwrap().is_empty(),
        "LIKE 兜底路径漏掉了行级回收站过滤"
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
