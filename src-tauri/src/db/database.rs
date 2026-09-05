use rusqlite::{params, Connection};

use super::models::{
    CellLoadRow, CsvCellIn, CsvFieldIn, CsvRowIn, DatabaseFieldRow, DatabaseRowRow,
};
use super::{dberr, now_ms};

// 数据库三表（database_fields / database_rows / database_cells）领域函数，
// 行形状与 tauri-plugin-sql 时代 select 结果逐字节一致。
// 002 迁移的两个触发器继续生效：
// - trg_cells_row_inserted：INSERT 行时为已有 created_at/last_edited_at 字段自动补单元格
// - trg_cells_value_changed：单元格值 UPDATE 且变化时刷新行 updated_at + last_edited_at

/// 镜像前端 database-values.ts defaultOptionsFor：新字段/改类型写入的默认 options JSON。
/// 键序由 serde_json 字典序决定，消费方 parseFieldOptions 按键名读取，无顺序依赖。
pub fn default_options_json(field_type: &str) -> String {
    match field_type {
        "single_select" | "multi_select" => serde_json::json!({ "kind": "select", "options": [] }).to_string(),
        "number" => serde_json::json!({
            "kind": "number", "format": "decimal", "precision": 2, "currency": "CNY"
        })
        .to_string(),
        "date" => serde_json::json!({ "kind": "date", "include_time": false }).to_string(),
        _ => serde_json::json!({ "kind": "none" }).to_string(),
    }
}

/// 表名只来自调用方写死的两处字面量，不接收用户输入。
fn next_position(conn: &Connection, table: &str, view_id: &str) -> Result<i64, String> {
    debug_assert!(matches!(table, "database_fields" | "database_rows"));
    conn.query_row(
        &format!("SELECT COALESCE(MAX(position), -1) + 1 FROM {table} WHERE database_view_id = ?1"),
        params![view_id],
        |r| r.get(0),
    )
    .map_err(dberr("next position"))
}

fn field_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseFieldRow> {
    Ok(DatabaseFieldRow {
        id: r.get(0)?,
        database_view_id: r.get(1)?,
        name: r.get(2)?,
        field_type: r.get(3)?,
        options: r.get(4)?,
        width: r.get(5)?,
        is_hidden: r.get(6)?,
        position: r.get(7)?,
    })
}

// ---------- 字段 ----------

pub fn list_fields(conn: &Connection, view_id: &str) -> Result<Vec<DatabaseFieldRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, database_view_id, name, field_type, options, width, is_hidden, position
             FROM database_fields WHERE database_view_id = ?1 ORDER BY position ASC",
        )
        .map_err(dberr("list fields"))?;
    let rows = stmt
        .query_map(params![view_id], field_from_row)
        .map_err(dberr("list fields"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list fields"))?;
    Ok(rows)
}

/// id 由前端 newId() 生成后传入；name 缺省用类型名（与旧 JS 一致）。
pub fn create_field(
    conn: &Connection,
    view_id: &str,
    id: &str,
    field_type: &str,
    name: Option<&str>,
) -> Result<DatabaseFieldRow, String> {
    let name = name.unwrap_or(field_type);
    let options = default_options_json(field_type);
    let position = next_position(conn, "database_fields", view_id)?;
    conn.execute(
        "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
         VALUES (?1, ?2, ?3, ?4, ?5, 180, 0, ?6)",
        params![id, view_id, name, field_type, options, position],
    )
    .map_err(dberr("create field"))?;
    Ok(DatabaseFieldRow {
        id: id.to_string(),
        database_view_id: view_id.to_string(),
        name: name.to_string(),
        field_type: field_type.to_string(),
        options,
        width: 180,
        is_hidden: 0,
        position,
    })
}

pub fn rename_field(conn: &Connection, field_id: &str, name: &str) -> Result<(), String> {
    conn.execute("UPDATE database_fields SET name = ?1 WHERE id = ?2", params![name, field_id])
        .map_err(dberr("rename field"))?;
    Ok(())
}

pub fn delete_field(conn: &Connection, field_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM database_fields WHERE id = ?1", params![field_id])
        .map_err(dberr("delete field"))?; // cells 经 FK 级联
    Ok(())
}

pub fn set_field_width(conn: &Connection, field_id: &str, width: i64) -> Result<(), String> {
    conn.execute("UPDATE database_fields SET width = ?1 WHERE id = ?2", params![width, field_id])
        .map_err(dberr("set field width"))?;
    Ok(())
}

pub fn set_field_hidden(conn: &Connection, field_id: &str, hidden: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE database_fields SET is_hidden = ?1 WHERE id = ?2",
        params![i64::from(hidden), field_id],
    )
    .map_err(dberr("set field hidden"))?;
    Ok(())
}

/// options 为已序列化 JSON 字符串（JS 侧 JSON.stringify 产出）。
pub fn update_field_options(conn: &Connection, field_id: &str, options: &str) -> Result<(), String> {
    conn.execute("UPDATE database_fields SET options = ?1 WHERE id = ?2", params![options, field_id])
        .map_err(dberr("update field options"))?;
    Ok(())
}

/// 整列重排：ordered_ids 为最终顺序（position 0..n-1）。单事务避免中间态。
pub fn reorder_fields(conn: &Connection, view_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("reorder fields"))?;
    for (i, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE database_fields SET position = ?1 WHERE id = ?2 AND database_view_id = ?3",
            params![i as i64, id, view_id],
        )
        .map_err(dberr("reorder fields"))?;
    }
    tx.commit().map_err(dberr("reorder fields (commit)"))?;
    Ok(())
}

/// 改字段类型：重置默认 options，并清空该字段所有单元格值（类型不兼容的数据不可保留）。
pub fn change_field_type(conn: &Connection, field_id: &str, new_type: &str) -> Result<(), String> {
    let options = default_options_json(new_type);
    conn.execute(
        "UPDATE database_fields SET field_type = ?1, options = ?2 WHERE id = ?3",
        params![new_type, options, field_id],
    )
    .map_err(dberr("change field type"))?;
    conn.execute("UPDATE database_cells SET value = 'null' WHERE field_id = ?1", params![field_id])
        .map_err(dberr("change field type (clear cells)"))?;
    Ok(())
}

// ---------- 行 ----------

fn row_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseRowRow> {
    Ok(DatabaseRowRow {
        id: r.get(0)?,
        database_view_id: r.get(1)?,
        position: r.get(2)?,
        document_id: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub fn list_rows(conn: &Connection, view_id: &str) -> Result<Vec<DatabaseRowRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, database_view_id, position, document_id, created_at, updated_at
             FROM database_rows WHERE database_view_id = ?1 ORDER BY position ASC",
        )
        .map_err(dberr("list rows"))?;
    let rows = stmt
        .query_map(params![view_id], row_from_row)
        .map_err(dberr("list rows"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list rows"))?;
    Ok(rows)
}

/// id 由前端 newId() 生成后传入；trg_cells_row_inserted 同事务补时间戳单元格。
pub fn create_row(conn: &Connection, view_id: &str, id: &str) -> Result<DatabaseRowRow, String> {
    let position = next_position(conn, "database_rows", view_id)?;
    let t = now_ms();
    conn.execute(
        "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, view_id, position, t],
    )
    .map_err(dberr("create row"))?;
    Ok(DatabaseRowRow {
        id: id.to_string(),
        database_view_id: view_id.to_string(),
        position,
        document_id: None,
        created_at: t,
        updated_at: t,
    })
}

/// 按 id 读单个行（行详情重开时需要最新 document_id）。
pub fn get_row(conn: &Connection, row_id: &str) -> Result<Option<DatabaseRowRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, database_view_id, position, document_id, created_at, updated_at
             FROM database_rows WHERE id = ?1",
        )
        .map_err(dberr("get row"))?;
    let mut rows = stmt.query_map(params![row_id], row_from_row).map_err(dberr("get row"))?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(dberr("get row")),
        None => Ok(None),
    }
}

/// 绑定行详情文档 view（首次打开行详情时创建）。
pub fn set_row_document_id(conn: &Connection, row_id: &str, document_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE database_rows SET document_id = ?1 WHERE id = ?2",
        params![document_id, row_id],
    )
    .map_err(dberr("set row document"))?;
    Ok(())
}

pub fn delete_row(conn: &Connection, row_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM database_rows WHERE id = ?1", params![row_id])
        .map_err(dberr("delete row"))?; // cells 经 FK 级联
    Ok(())
}

pub fn reorder_rows(conn: &Connection, view_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("reorder rows"))?;
    for (i, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE database_rows SET position = ?1 WHERE id = ?2 AND database_view_id = ?3",
            params![i as i64, id, view_id],
        )
        .map_err(dberr("reorder rows"))?;
    }
    tx.commit().map_err(dberr("reorder rows (commit)"))?;
    Ok(())
}

// ---------- 单元格 ----------

/// 全量读取某视图所有单元格（扁平行；JS 侧组装成 rowId → fieldId → 值并 JSON.parse）。
pub fn load_cells(conn: &Connection, view_id: &str) -> Result<Vec<CellLoadRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.row_id, c.field_id, c.value
             FROM database_cells c
             JOIN database_rows r ON r.id = c.row_id
             WHERE r.database_view_id = ?1",
        )
        .map_err(dberr("load cells"))?;
    let rows = stmt
        .query_map(params![view_id], |r| {
            Ok(CellLoadRow {
                row_id: r.get(0)?,
                field_id: r.get(1)?,
                value: r.get(2)?,
            })
        })
        .map_err(dberr("load cells"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("load cells"))?;
    Ok(rows)
}

/// upsert 单元格。value 为已序列化 JSON 字符串（JS 侧 serializeValue 产出，与旧库字节一致）。
pub fn set_cell(conn: &Connection, row_id: &str, field_id: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO database_cells(row_id, field_id, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(row_id, field_id) DO UPDATE SET value = ?3",
        params![row_id, field_id, value],
    )
    .map_err(dberr("set cell"))?;
    Ok(())
}

/// CSV 导入单命令：一个事务内落全部字段/行/单元格（替代旧 JS 侧 N+1 IPC 循环）。
/// 字段默认 options 在 Rust 侧生成；position 按入参顺序 0..n-1。
pub fn csv_import(
    conn: &Connection,
    view_id: &str,
    fields: &[CsvFieldIn],
    rows: &[CsvRowIn],
) -> Result<(usize, usize, usize), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("csv import"))?;
    for (i, f) in fields.iter().enumerate() {
        tx.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES (?1, ?2, ?3, ?4, ?5, 180, 0, ?6)",
            params![f.id, view_id, f.name, f.field_type, default_options_json(&f.field_type), i as i64],
        )
        .map_err(dberr("csv import"))?;
    }
    let mut cell_count = 0usize;
    for (i, r) in rows.iter().enumerate() {
        let t = now_ms();
        tx.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![r.id, view_id, i as i64, t],
        )
        .map_err(dberr("csv import"))?;
        for c in &r.cells {
            tx.execute(
                "INSERT INTO database_cells(row_id, field_id, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(row_id, field_id) DO UPDATE SET value = ?3",
                params![r.id, c.field_id, c.value],
            )
            .map_err(dberr("csv import"))?;
            cell_count += 1;
        }
    }
    tx.commit().map_err(dberr("csv import (commit)"))?;
    Ok((fields.len(), rows.len(), cell_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1', 'w1', NULL, '表格', 'grid', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn cells_of(conn: &Connection, field_id: &str) -> Vec<CellLoadRow> {
        load_cells(conn, "v1")
            .unwrap()
            .into_iter()
            .filter(|c| c.field_id == field_id)
            .collect()
    }

    // ---------- 字段 ----------

    #[test]
    fn create_field_defaults_match_legacy_js_shape() {
        let conn = setup();
        let f = create_field(&conn, "v1", "f1", "text", None).unwrap();
        assert_eq!(f.name, "text"); // name 缺省 = 类型名
        assert_eq!(f.width, 180);
        assert_eq!(f.is_hidden, 0);
        assert_eq!(f.position, 0);
        assert_eq!(f.options, r#"{"kind":"none"}"#);

        let f2 = create_field(&conn, "v1", "f2", "single_select", Some("状态")).unwrap();
        assert_eq!(f2.name, "状态");
        assert_eq!(f2.position, 1);
        assert_eq!(f2.options, r#"{"kind":"select","options":[]}"#);
    }

    #[test]
    fn default_options_per_type() {
        assert_eq!(
            default_options_json("number"),
            r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
        );
        assert_eq!(default_options_json("date"), r#"{"include_time":false,"kind":"date"}"#);
        assert_eq!(default_options_json("multi_select"), r#"{"kind":"select","options":[]}"#);
        assert_eq!(default_options_json("checkbox"), r#"{"kind":"none"}"#);
    }

    #[test]
    fn field_update_ops() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", Some("名")).unwrap();

        rename_field(&conn, "f1", "新名").unwrap();
        set_field_width(&conn, "f1", 240).unwrap();
        set_field_hidden(&conn, "f1", true).unwrap();
        update_field_options(&conn, "f1", r#"{"kind":"number"}"#).unwrap();

        let fs = list_fields(&conn, "v1").unwrap();
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].name, "新名");
        assert_eq!(fs[0].width, 240);
        assert_eq!(fs[0].is_hidden, 1);
        assert_eq!(fs[0].options, r#"{"kind":"number"}"#);
    }

    #[test]
    fn reorder_fields_assigns_final_positions() {
        let conn = setup();
        for id in ["f1", "f2", "f3"] {
            create_field(&conn, "v1", id, "text", None).unwrap();
        }
        reorder_fields(&conn, "v1", &["f3", "f1", "f2"]).unwrap();
        let fs = list_fields(&conn, "v1").unwrap();
        let order: Vec<&str> = fs.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(order, vec!["f3", "f1", "f2"]);
        let positions: Vec<i64> = fs.iter().map(|f| f.position).collect();
        assert_eq!(positions, vec![0, 1, 2]);
    }

    #[test]
    fn change_field_type_resets_options_and_clears_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1").unwrap();
        set_cell(&conn, "r1", "f1", r#""hello""#).unwrap();

        change_field_type(&conn, "f1", "number").unwrap();

        let f = &list_fields(&conn, "v1").unwrap()[0];
        assert_eq!(f.field_type, "number");
        assert_eq!(
            f.options,
            r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
        );
        let f1_cells = cells_of(&conn, "f1");
        assert_eq!(f1_cells.len(), 1); // 行还在，单元格没被删
        assert_eq!(f1_cells[0].value, "null");
    }

    #[test]
    fn delete_field_cascades_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1").unwrap();
        set_cell(&conn, "r1", "f1", r#""x""#).unwrap();

        delete_field(&conn, "f1").unwrap();
        assert!(list_fields(&conn, "v1").unwrap().is_empty());
        assert!(load_cells(&conn, "v1").unwrap().is_empty());
    }

    // ---------- 行 ----------

    #[test]
    fn row_crud_and_document_binding() {
        let conn = setup();
        let r = create_row(&conn, "v1", "r1").unwrap();
        assert_eq!(r.position, 0);
        assert_eq!(r.document_id, None);
        assert_eq!(r.created_at, r.updated_at);

        create_row(&conn, "v1", "r2").unwrap();

        let got = get_row(&conn, "r1").unwrap().unwrap();
        assert_eq!(got.id, "r1");
        assert!(get_row(&conn, "ghost").unwrap().is_none());

        set_row_document_id(&conn, "r1", "doc-1").unwrap();
        assert_eq!(get_row(&conn, "r1").unwrap().unwrap().document_id.as_deref(), Some("doc-1"));

        delete_row(&conn, "r2").unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r1");
    }

    /// trg_cells_row_inserted：视图已有 created_at/last_edited_at 字段时，插行自动补时间戳单元格
    #[test]
    fn row_insert_trigger_fills_timestamp_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f-created", "created_at", None).unwrap();
        create_field(&conn, "v1", "f-edited", "last_edited_at", None).unwrap();

        create_row(&conn, "v1", "r1").unwrap();

        let created = cells_of(&conn, "f-created");
        assert_eq!(created.len(), 1);
        assert!(created[0].value.ends_with('Z'), "UTC ISO 秒级: {}", created[0].value);
        let edited = cells_of(&conn, "f-edited");
        assert_eq!(edited.len(), 1);
    }

    #[test]
    fn reorder_rows_assigns_final_positions() {
        let conn = setup();
        for id in ["r1", "r2", "r3"] {
            create_row(&conn, "v1", id).unwrap();
        }
        reorder_rows(&conn, "v1", &["r2", "r3", "r1"]).unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        let order: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(order, vec!["r2", "r3", "r1"]);
    }

    #[test]
    fn delete_row_cascades_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1").unwrap();
        set_cell(&conn, "r1", "f1", r#""x""#).unwrap();

        delete_row(&conn, "r1").unwrap();
        assert!(list_rows(&conn, "v1").unwrap().is_empty());
        assert!(load_cells(&conn, "v1").unwrap().is_empty());
    }

    // ---------- 单元格 ----------

    #[test]
    fn load_cells_empty_then_upsert() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1").unwrap();
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
        create_row(&conn, "v1", "r1").unwrap();

        // 手动把 updated_at 设到过去，观察触发器是否刷回当前时间
        conn.execute("UPDATE database_rows SET updated_at = 12345 WHERE id = 'r1'", []).unwrap();

        set_cell(&conn, "r1", "f1", r#""a""#).unwrap(); // INSERT 路径
        assert_eq!(get_row(&conn, "r1").unwrap().unwrap().updated_at, 12345);

        set_cell(&conn, "r1", "f1", r#""b""#).unwrap(); // UPDATE 路径
        assert!(get_row(&conn, "r1").unwrap().unwrap().updated_at > 12345, "触发器应刷新 updated_at");

        // 值相同再写一遍：WHEN old.value IS NOT new.value 不触发，不空转
        conn.execute("UPDATE database_rows SET updated_at = 12345 WHERE id = 'r1'", []).unwrap();
        set_cell(&conn, "r1", "f1", r#""b""#).unwrap();
        assert_eq!(get_row(&conn, "r1").unwrap().unwrap().updated_at, 12345);
    }

    #[test]
    fn set_cell_fk_guard() {
        let conn = setup();
        let err = set_cell(&conn, "ghost-row", "ghost-field", "1").unwrap_err();
        assert!(err.contains("FOREIGN KEY"), "{err}");
    }

    // ---------- CSV 导入 ----------

    #[test]
    fn csv_import_lands_everything_in_one_transaction() {
        let conn = setup();
        let fields = vec![
            CsvFieldIn { id: "f1".into(), name: "名称".into(), field_type: "text".into() },
            CsvFieldIn { id: "f2".into(), name: "数量".into(), field_type: "number".into() },
        ];
        let rows = vec![
            CsvRowIn {
                id: "r1".into(),
                cells: vec![
                    CsvCellIn { field_id: "f1".into(), value: r#""a""#.into() },
                    CsvCellIn { field_id: "f2".into(), value: "1".into() },
                ],
            },
            CsvRowIn { id: "r2".into(), cells: vec![] },
        ];
        let (nf, nr, nc) = csv_import(&conn, "v1", &fields, &rows).unwrap();
        assert_eq!((nf, nr, nc), (2, 2, 2));

        let fs = list_fields(&conn, "v1").unwrap();
        assert_eq!(fs.iter().map(|f| f.position).collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(fs[1].options, r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#);
        let rs = list_rows(&conn, "v1").unwrap();
        assert_eq!(rs.iter().map(|r| r.position).collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(load_cells(&conn, "v1").unwrap().len(), 2);
    }

    #[test]
    fn csv_import_rolls_back_on_bad_field_type() {
        let conn = setup();
        let fields = vec![
            CsvFieldIn { id: "f1".into(), name: "ok".into(), field_type: "text".into() },
            CsvFieldIn { id: "f2".into(), name: "bad".into(), field_type: "ghost_type".into() }, // CHECK 约束拒绝
        ];
        let rows = vec![CsvRowIn { id: "r1".into(), cells: vec![] }];
        let err = csv_import(&conn, "v1", &fields, &rows).unwrap_err();
        assert!(err.contains("CHECK"), "{err}");
        // 整体回滚：合法的 f1 也不存在
        assert!(list_fields(&conn, "v1").unwrap().is_empty());
        assert!(list_rows(&conn, "v1").unwrap().is_empty());
    }
}
