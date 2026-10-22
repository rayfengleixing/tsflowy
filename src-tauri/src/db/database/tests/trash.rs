// 行回收站用例（从 tests/mod.rs 原样搬入，断言未改）。
use super::*;

// ---------- 行回收站 ----------

/// 读原始标记列：list_rows/list_trash_rows 已经按 is_trash 过滤，测试要看底层真实状态
fn trash_flag(conn: &Connection, row_id: &str) -> i64 {
    conn.query_row(
        "SELECT is_trash FROM database_rows WHERE id = ?1",
        params![row_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn seed_doc_view(conn: &Connection, id: &str) {
    conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', 'v1', '行详情', 'document', '{\"row_detail\":true}', 1, 1, 1)",
            params![id],
        )
        .unwrap();
}

fn doc_trash_flag(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT is_trash FROM views WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn soft_delete_hides_row_but_keeps_cells() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_rows(&conn, "v1", &["r1".into(), "r2".into(), "r3".into()]).unwrap();
    set_cell(&conn, "r2", "f1", r#""任务 B""#).unwrap();

    let n = soft_delete_rows(&conn, &["r2".into(), "ghost".into()]).unwrap();
    assert_eq!(n, 1, "不存在的 id 不计入，也不中断整批");

    let ids: Vec<String> = list_rows(&conn, "v1")
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["r1", "r3"],
        "剩下的行压紧行号，回收站里的行不再出现"
    );
    assert_eq!(
        list_rows(&conn, "v1")
            .unwrap()
            .iter()
            .map(|r| r.position)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert!(
        load_cells(&conn, "v1").unwrap().is_empty(),
        "r2 的单元格读不到"
    );
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM database_cells", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 1, "软删只是打标记，单元格留在库里等着恢复");

    let trash = list_trash_rows(&conn, "v1").unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].id, "r2");
    assert_eq!(trash[0].title, "任务 B", "列表要能认出删掉的是哪一行");
    assert!(trash[0].deleted_at.is_some());

    // 重复软删同一行不计数（幂等，前端重试安全）
    assert_eq!(soft_delete_rows(&conn, &["r2".into()]).unwrap(), 0);
    assert_eq!(trash_flag(&conn, "r2"), 1);
}

#[test]
fn restore_row_appends_it_at_the_end() {
    let conn = setup();
    create_rows(
        &conn,
        "v1",
        &["r1".into(), "r2".into(), "r3".into(), "r4".into()],
    )
    .unwrap();
    soft_delete_rows(&conn, &["r2".into()]).unwrap();
    // 回收站期间又删掉一行并新增一行，原 position 早已不属于它
    soft_delete_rows(&conn, &["r3".into()]).unwrap();
    create_row(&conn, "v1", "r5", None).unwrap();

    restore_row(&conn, "r2").unwrap();
    let rows = list_rows(&conn, "v1").unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| (r.id.as_str(), r.position))
            .collect::<Vec<_>>(),
        vec![("r1", 0), ("r4", 1), ("r5", 2), ("r2", 3)],
        "恢复排在可见行末尾，行号连续不撞号"
    );
    assert_eq!(trash_flag(&conn, "r2"), 0);
    assert!(list_trash_rows(&conn, "v1")
        .unwrap()
        .iter()
        .all(|t| t.id != "r2"));

    let err = restore_row(&conn, "r2").unwrap_err();
    assert!(err.contains("r2"), "重复恢复要报错而不是静默：{err}");
}

#[test]
fn row_document_follows_the_row_into_and_out_of_trash() {
    let conn = setup();
    create_row(&conn, "v1", "r1", None).unwrap();
    seed_doc_view(&conn, "d1");
    set_row_document_id(&conn, "r1", "d1").unwrap();

    soft_delete_rows(&conn, &["r1".into()]).unwrap();
    assert_eq!(
        doc_trash_flag(&conn, "d1"),
        1,
        "行删了，详情文档不能再被搜到"
    );

    restore_row(&conn, "r1").unwrap();
    assert_eq!(doc_trash_flag(&conn, "d1"), 0);

    // 详情文档也会被「页面回收站的自动清空」连带删掉：恢复行时 document_id 要清成 NULL，
    // 否则下次打开行详情会拿着悬空 id 报 "row detail view missing"
    soft_delete_rows(&conn, &["r1".into()]).unwrap();
    crate::db::views::purge_expired_trash(&conn, "w1", i64::MAX).unwrap();
    restore_row(&conn, "r1").unwrap();
    assert_eq!(
        get_row(&conn, "r1").unwrap().unwrap().document_id,
        None,
        "文档已被清空时不留悬空引用"
    );

    // 彻底删除：文档一并清掉，不留 hidden 孤儿页
    soft_delete_rows(&conn, &["r1".into()]).unwrap();
    purge_rows(&conn, &["r1".into()]).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id = 'd1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0, "行彻底删除时行详情文档也要消失");
}

#[test]
fn purge_trash_rows_empties_one_table_only() {
    let conn = setup();
    conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v2', 'w1', NULL, '第二张表', 'grid', '{}', 2, 1, 1)",
            [],
        )
        .unwrap();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_field(&conn, "v2", "f2", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    create_row(&conn, "v2", "r2", None).unwrap();
    soft_delete_rows(&conn, &["r1".into(), "r2".into()]).unwrap();

    let n = purge_trash_rows(&conn, "v1").unwrap();
    assert_eq!(n, 1);
    assert!(list_trash_rows(&conn, "v1").unwrap().is_empty());
    assert_eq!(
        list_trash_rows(&conn, "v2").unwrap().len(),
        1,
        "别表的回收站不受影响"
    );
    let cells: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM database_cells WHERE row_id = 'r1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cells, 0, "彻底删除才走 FK 级联清单元格");
}

#[test]
fn purge_expired_trash_rows_respects_the_deadline() {
    let conn = setup();
    create_rows(&conn, "v1", &["r1".into(), "r2".into()]).unwrap();
    soft_delete_rows(&conn, &["r1".into(), "r2".into()]).unwrap();
    conn.execute(
        "UPDATE database_rows SET deleted_at = 1000 WHERE id = 'r1'",
        [],
    )
    .unwrap();

    let n = purge_expired_trash_rows(&conn, 5000).unwrap();
    assert_eq!(n, 1, "只清过期的一条");
    let left: Vec<String> = list_trash_rows(&conn, "v1")
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(left, vec!["r2"]);
}
