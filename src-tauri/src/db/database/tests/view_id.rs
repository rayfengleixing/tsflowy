// 派生视图 id 折算到宿主的用例（从 tests/mod.rs 原样搬入，断言未改）。
use super::*;
use crate::db::models::{CsvCellIn, CsvFieldIn, CsvRowIn};
use crate::db::views::data_view_id;

// ---------- 多视图：派生视图 id 折算到宿主 ----------

fn derive(conn: &Connection, id: &str, host: &str, layout: &str) {
    conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at, source_id)
             VALUES (?1, 'w1', NULL, ?1, ?2, '{}', 0, 1, 1, ?3)",
            params![id, layout, host],
        )
        .unwrap();
}

#[test]
fn data_view_id_maps_derived_to_host_and_passes_others_through() {
    let conn = setup();
    derive(&conn, "v1-board", "v1", "board");
    assert_eq!(data_view_id(&conn, "v1-board").unwrap(), "v1");
    assert_eq!(data_view_id(&conn, "v1").unwrap(), "v1", "宿主折算到自己");
    // 视图行不存在时原样返回：查询得到空集，不在已删视图的残留标签页上报错
    assert_eq!(data_view_id(&conn, "ghost").unwrap(), "ghost");
}

#[test]
fn every_view_id_entry_point_resolves_to_the_host() {
    let conn = setup();
    derive(&conn, "v1-board", "v1", "board");
    let derived = "v1-board";

    let f = create_field(&conn, derived, "f1", "text", Some("名称")).unwrap();
    assert_eq!(f.database_view_id, "v1", "返回行报告真实归属");
    assert_eq!(
        list_fields(&conn, derived).unwrap().len(),
        1,
        "派生视图读得到宿主字段"
    );

    let r = create_row(&conn, derived, "r1", None).unwrap();
    assert_eq!(r.database_view_id, "v1");
    set_cell(&conn, "r1", "f1", r#""x""#).unwrap();
    assert_eq!(load_cells(&conn, derived).unwrap().len(), 1);
    assert_eq!(
        list_rows(&conn, "v1").unwrap()[0].id,
        "r1",
        "宿主读得到派生视图建的行"
    );

    create_field(&conn, derived, "f2", "number", None).unwrap();
    reorder_fields(&conn, derived, &["f2", "f1"]).unwrap();
    let order: Vec<String> = list_fields(&conn, "v1")
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect();
    assert_eq!(order, vec!["f2", "f1"]);

    let fields = vec![CsvFieldIn {
        id: "f3".into(),
        name: "导入".into(),
        field_type: "text".into(),
        options: None,
    }];
    let rows = vec![CsvRowIn {
        id: "r3".into(),
        cells: vec![CsvCellIn {
            field_id: "f3".into(),
            value: r#""v""#.into(),
        }],
    }];
    let (nf, nr, nc) = csv_import(&conn, derived, &fields, &rows).unwrap();
    assert_eq!((nf, nr, nc), (1, 1, 1));
    assert_eq!(list_rows(&conn, "v1").unwrap().len(), 2);
}
