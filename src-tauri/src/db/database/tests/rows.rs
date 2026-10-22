// 行域用例（从 tests/mod.rs 原样搬入，断言未改）。
use super::*;

#[test]
fn row_crud_and_document_binding() {
    let conn = setup();
    let r = create_row(&conn, "v1", "r1", None).unwrap();
    assert_eq!(r.position, 0);
    assert_eq!(r.document_id, None);
    assert_eq!(r.created_at, r.updated_at);

    create_row(&conn, "v1", "r2", None).unwrap();

    let got = get_row(&conn, "r1").unwrap().unwrap();
    assert_eq!(got.id, "r1");
    assert!(get_row(&conn, "ghost").unwrap().is_none());

    set_row_document_id(&conn, "r1", "doc-1").unwrap();
    assert_eq!(
        get_row(&conn, "r1")
            .unwrap()
            .unwrap()
            .document_id
            .as_deref(),
        Some("doc-1")
    );

    purge_rows(&conn, &["r2".into()]).unwrap();
    let rows = list_rows(&conn, "v1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "r1");
}

/// 父子行层级：parent_id 随行模型读写，父行被彻底删除时子行脱钩回顶层（FK SET NULL）。
#[test]
fn row_parent_roundtrip_and_detach_on_purge() {
    let conn = setup();
    create_row(&conn, "v1", "r1", None).unwrap();
    let child = create_row(&conn, "v1", "r2", Some("r1")).unwrap();
    assert_eq!(child.parent_id.as_deref(), Some("r1"));
    assert_eq!(
        get_row(&conn, "r2").unwrap().unwrap().parent_id.as_deref(),
        Some("r1")
    );
    let parents: Vec<Option<String>> = list_rows(&conn, "v1")
        .unwrap()
        .into_iter()
        .map(|r| r.parent_id)
        .collect();
    assert_eq!(parents, vec![None, Some("r1".into())]);

    purge_rows(&conn, &["r1".into()]).unwrap();
    assert_eq!(
        get_row(&conn, "r2").unwrap().unwrap().parent_id,
        None,
        "父行彻底删除后子行要回到顶层，而不是挂着幽灵父引用"
    );

    set_row_parent(&conn, "r2", None).unwrap();
    assert_eq!(get_row(&conn, "r2").unwrap().unwrap().parent_id, None);
}

/// 非法父行一律拒绝：自己、后代（成环）、别的表、回收站里的行、不存在的 id。
#[test]
fn set_row_parent_rejects_invalid_parents() {
    let conn = setup();
    conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v2', 'w1', NULL, '第二张表', 'grid', '{}', 2, 1, 1)",
            [],
        )
        .unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    create_row(&conn, "v1", "r2", Some("r1")).unwrap();
    create_row(&conn, "v2", "r3", None).unwrap();

    assert!(set_row_parent(&conn, "r1", Some("r1"))
        .unwrap_err()
        .contains("own parent"));
    assert!(set_row_parent(&conn, "r1", Some("r2"))
        .unwrap_err()
        .contains("own descendant"));
    assert!(set_row_parent(&conn, "r2", Some("r3"))
        .unwrap_err()
        .contains("another table"));
    assert!(set_row_parent(&conn, "r2", Some("ghost"))
        .unwrap_err()
        .contains("not found"));

    // 幂等：父行没变就直接返回，连校验和 updated_at 都不碰
    let before = get_row(&conn, "r2").unwrap().unwrap().updated_at;
    set_row_parent(&conn, "r2", Some("r1")).unwrap();
    assert_eq!(get_row(&conn, "r2").unwrap().unwrap().updated_at, before);

    // 父行进了回收站也不能再被选中（它已经不在可见行集合里）
    create_row(&conn, "v1", "r4", None).unwrap();
    soft_delete_rows(&conn, &["r1".into()]).unwrap();
    assert!(set_row_parent(&conn, "r4", Some("r1"))
        .unwrap_err()
        .contains("in trash"));
}

/// 深度限额 4 层：新建第 5 层被挡，整棵子树搬深时被搬子树的最深一条线也要计入。
#[test]
fn row_hierarchy_stops_at_the_depth_limit() {
    let conn = setup();
    create_row(&conn, "v1", "l1", None).unwrap();
    create_row(&conn, "v1", "l2", Some("l1")).unwrap();
    create_row(&conn, "v1", "l3", Some("l2")).unwrap();
    create_row(&conn, "v1", "l4", Some("l3")).unwrap();
    assert!(create_row(&conn, "v1", "l5", Some("l4"))
        .unwrap_err()
        .contains("depth"));
    assert!(set_row_parent(&conn, "l3", Some("l4"))
        .unwrap_err()
        .contains("descendant"));

    // l2 下面挂着 l3、l4（子树高 2），搬到第 1 层行之下最深到第 4 行仍然允许
    create_row(&conn, "v1", "x1", None).unwrap();
    set_row_parent(&conn, "l2", Some("x1")).unwrap();
    assert_eq!(
        get_row(&conn, "l4").unwrap().unwrap().parent_id.as_deref(),
        Some("l3"),
        "改父行只动被搬那一行，子树跟着走是层级结构本身的语义"
    );

    // 同一棵子树搬到第 2 层行之下会最深到第 5 层：按深度拒绝，不是因为成环
    create_row(&conn, "v1", "y1", None).unwrap();
    create_row(&conn, "v1", "y2", Some("y1")).unwrap();
    let err = set_row_parent(&conn, "l2", Some("y2")).unwrap_err();
    assert!(err.contains("depth"), "{err}");
    assert_eq!(
        get_row(&conn, "l2").unwrap().unwrap().parent_id.as_deref(),
        Some("x1"),
        "被拒绝的改动不能留下半个层级"
    );
}

/// trg_cells_row_inserted：视图已有 created_at/last_edited_at 字段时，插行自动补时间戳单元格
#[test]
fn row_insert_trigger_fills_timestamp_cells() {
    let conn = setup();
    create_field(&conn, "v1", "f-created", "created_at", None).unwrap();
    create_field(&conn, "v1", "f-edited", "last_edited_at", None).unwrap();

    create_row(&conn, "v1", "r1", None).unwrap();

    let created = cells_of(&conn, "f-created");
    assert_eq!(created.len(), 1);
    assert!(
        created[0].value.ends_with('Z'),
        "UTC ISO 秒级: {}",
        created[0].value
    );
    let edited = cells_of(&conn, "f-edited");
    assert_eq!(edited.len(), 1);
}

#[test]
fn reorder_rows_assigns_final_positions() {
    let conn = setup();
    for id in ["r1", "r2", "r3"] {
        create_row(&conn, "v1", id, None).unwrap();
    }
    reorder_rows(&conn, "v1", &["r2", "r3", "r1"]).unwrap();
    let rows = list_rows(&conn, "v1").unwrap();
    let order: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(order, vec!["r2", "r3", "r1"]);
}

#[test]
fn purge_row_cascades_cells() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""x""#).unwrap();

    purge_rows(&conn, &["r1".into()]).unwrap();
    assert!(list_rows(&conn, "v1").unwrap().is_empty());
    assert!(load_cells(&conn, "v1").unwrap().is_empty());
}

/// 删除后剩余行 position 压紧 0..n-1：行号列按 position 显示，不跳号
#[test]
fn delete_compacts_row_positions() {
    let conn = setup();
    create_rows(
        &conn,
        "v1",
        &["r1".into(), "r2".into(), "r3".into(), "r4".into()],
    )
    .unwrap();

    purge_rows(&conn, &["r2".into()]).unwrap();
    let rows = list_rows(&conn, "v1").unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| (r.id.as_str(), r.position))
            .collect::<Vec<_>>(),
        vec![("r1", 0), ("r3", 1), ("r4", 2)]
    );

    // 批量删除（含缺 id）同样压紧
    purge_rows(&conn, &["r1".into(), "ghost".into()]).unwrap();
    let rows = list_rows(&conn, "v1").unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| (r.id.as_str(), r.position))
            .collect::<Vec<_>>(),
        vec![("r3", 0), ("r4", 1)]
    );
}
