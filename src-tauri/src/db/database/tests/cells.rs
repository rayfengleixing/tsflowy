// 单元格域与 CSV 导入用例（从 tests/mod.rs 原样搬入，断言未改）。
use super::*;
use crate::db::models::{CellSetIn, CsvCellIn, CsvFieldIn, CsvRowIn};

// ---------- 单元格 ----------

#[test]
fn load_cells_empty_then_upsert() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    assert!(load_cells(&conn, "v1").unwrap().is_empty());

    set_cell(&conn, "r1", "f1", r#""a""#).unwrap();
    let cells = cells_of(&conn, "f1");
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].row_id, "r1");
    assert_eq!(cells[0].value, r#""a""#);

    set_cell(&conn, "r1", "f1", r#""b""#).unwrap(); // upsert 覆盖，不产生第二行
    let cells = cells_of(&conn, "f1");
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].value, r#""b""#);
}

/// trg_cells_value_changed：值 UPDATE 且变化时刷新行 updated_at（INSERT 路径不触发）
#[test]
fn cell_update_trigger_refreshes_row_timestamp() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();

    // 手动把 updated_at 设到过去，观察触发器是否刷回当前时间
    conn.execute(
        "UPDATE database_rows SET updated_at = 12345 WHERE id = 'r1'",
        [],
    )
    .unwrap();

    set_cell(&conn, "r1", "f1", r#""a""#).unwrap(); // INSERT 路径
    assert_eq!(get_row(&conn, "r1").unwrap().unwrap().updated_at, 12345);

    set_cell(&conn, "r1", "f1", r#""b""#).unwrap(); // UPDATE 路径
    assert!(
        get_row(&conn, "r1").unwrap().unwrap().updated_at > 12345,
        "触发器应刷新 updated_at"
    );

    // 值相同再写一遍：WHEN old.value IS NOT new.value 不触发，不空转
    conn.execute(
        "UPDATE database_rows SET updated_at = 12345 WHERE id = 'r1'",
        [],
    )
    .unwrap();
    set_cell(&conn, "r1", "f1", r#""b""#).unwrap();
    assert_eq!(get_row(&conn, "r1").unwrap().unwrap().updated_at, 12345);
}

#[test]
fn set_cell_fk_guard() {
    let conn = setup();
    let err = set_cell(&conn, "ghost-row", "ghost-field", "1").unwrap_err();
    assert!(err.contains("FOREIGN KEY"), "{err}");
}

// ---------- 批量写（TSV 粘贴路径） ----------

fn cell_set_in(row: &str, field: &str, value: &str) -> CellSetIn {
    CellSetIn {
        row_id: row.into(),
        field_id: field.into(),
        value: value.into(),
    }
}

#[test]
fn set_cells_many_upserts_and_rolls_back_atomically() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();

    let n = set_cells_many(
        &conn,
        &[
            cell_set_in("r1", "f1", r#""a""#),
            cell_set_in("r1", "f1", r#""b""#), // 同格后写覆盖先写
        ],
    )
    .unwrap();
    assert_eq!(n, 2);
    assert_eq!(cells_of(&conn, "f1")[0].value, r#""b""#);

    // 任一条 FK 违例 → 整批回滚，先写入的合法项也不落库
    let err = set_cells_many(
        &conn,
        &[
            cell_set_in("r1", "f1", r#""c""#),
            cell_set_in("ghost", "f1", "1"),
        ],
    )
    .unwrap_err();
    assert!(err.contains("FOREIGN KEY"), "{err}");
    assert_eq!(cells_of(&conn, "f1")[0].value, r#""b""#);
}

#[test]
fn create_rows_appends_positions_and_rolls_back_on_duplicate() {
    let conn = setup();
    create_row(&conn, "v1", "r1", None).unwrap();

    let made = create_rows(&conn, "v1", &["r2".into(), "r3".into()]).unwrap();
    assert_eq!(
        made.iter().map(|r| r.position).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(made[1].database_view_id, "v1");
    assert_eq!(list_rows(&conn, "v1").unwrap().len(), 3);

    let err = create_rows(&conn, "v1", &["r4".into(), "r2".into()]).unwrap_err();
    assert!(err.contains("UNIQUE"), "{err}");
    let ids: Vec<String> = list_rows(&conn, "v1")
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec!["r1", "r2", "r3"], "整批回滚：r4 不落库");
}

#[test]
fn purge_rows_removes_all_and_cascades_cells() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_rows(&conn, "v1", &["r1".into(), "r2".into(), "r3".into()]).unwrap();
    set_cells_many(
        &conn,
        &[
            CellSetIn {
                row_id: "r2".into(),
                field_id: "f1".into(),
                value: r#""x""#.into(),
            },
            CellSetIn {
                row_id: "r3".into(),
                field_id: "f1".into(),
                value: r#""y""#.into(),
            },
        ],
    )
    .unwrap();

    // 多选删除：已不存在的 id 不计入、也不中断整批
    let n = purge_rows(&conn, &["r2".into(), "ghost".into()]).unwrap();
    assert_eq!(n, 1);
    let ids: Vec<String> = list_rows(&conn, "v1")
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec!["r1", "r3"]);
    let left = cells_of(&conn, "f1");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].row_id, "r3", "r2 的单元格随行级联删除");
}

// ---------- CSV 导入 ----------

#[test]
fn csv_import_lands_everything_in_one_transaction() {
    let conn = setup();
    let fields = vec![
        CsvFieldIn {
            id: "f1".into(),
            name: "名称".into(),
            field_type: "text".into(),
            options: None,
        },
        CsvFieldIn {
            id: "f2".into(),
            name: "数量".into(),
            field_type: "number".into(),
            options: None,
        },
    ];
    let rows = vec![
        CsvRowIn {
            id: "r1".into(),
            cells: vec![
                CsvCellIn {
                    field_id: "f1".into(),
                    value: r#""a""#.into(),
                },
                CsvCellIn {
                    field_id: "f2".into(),
                    value: "1".into(),
                },
            ],
        },
        CsvRowIn {
            id: "r2".into(),
            cells: vec![],
        },
    ];
    let (nf, nr, nc) = csv_import(&conn, "v1", &fields, &rows).unwrap();
    assert_eq!((nf, nr, nc), (2, 2, 2));

    let fs = list_fields(&conn, "v1").unwrap();
    assert_eq!(
        fs.iter().map(|f| f.position).collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(
        fs[1].options,
        r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
    );
    let rs = list_rows(&conn, "v1").unwrap();
    assert_eq!(
        rs.iter().map(|r| r.position).collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(load_cells(&conn, "v1").unwrap().len(), 2);
}

#[test]
fn csv_import_rolls_back_on_bad_field_type() {
    let conn = setup();
    let fields = vec![
        CsvFieldIn {
            id: "f1".into(),
            name: "ok".into(),
            field_type: "text".into(),
            options: None,
        },
        CsvFieldIn {
            id: "f2".into(),
            name: "bad".into(),
            field_type: "ghost_type".into(),
            options: None,
        }, // CHECK 约束拒绝
    ];
    let rows = vec![CsvRowIn {
        id: "r1".into(),
        cells: vec![],
    }];
    let err = csv_import(&conn, "v1", &fields, &rows).unwrap_err();
    assert!(err.contains("CHECK"), "{err}");
    // 整体回滚：合法的 f1 也不存在
    assert!(list_fields(&conn, "v1").unwrap().is_empty());
    assert!(list_rows(&conn, "v1").unwrap().is_empty());
}

#[test]
fn csv_import_lands_provided_options_for_select_fields() {
    let conn = setup();
    let fields = vec![CsvFieldIn {
        id: "f1".into(),
        name: "状态".into(),
        field_type: "single_select".into(),
        options: Some(
            r#"{"kind":"select","options":[{"id":"o1","name":"进行中","color":"blue"}]}"#.into(),
        ),
    }];
    let rows = vec![CsvRowIn {
        id: "r1".into(),
        cells: vec![CsvCellIn {
            field_id: "f1".into(),
            value: r#""o1""#.into(),
        }],
    }];
    csv_import(&conn, "v1", &fields, &rows).unwrap();
    let fs = list_fields(&conn, "v1").unwrap();
    assert_eq!(
        fs[0].options,
        r#"{"kind":"select","options":[{"id":"o1","name":"进行中","color":"blue"}]}"#
    );
}
