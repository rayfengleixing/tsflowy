use rusqlite::OptionalExtension;

use super::super::models::CellLoadRow;
use super::*;

mod cells;
mod fields;
mod rows;
mod trash;
mod view_id;

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

fn add_view(conn: &Connection, id: &str, name: &str, source_id: Option<&str>) {
    conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at, source_id)
             VALUES (?1, 'w1', NULL, ?2, 'grid', '{}', 0, 1, 1, ?3)",
            params![id, name, source_id],
        )
        .unwrap();
}

fn options_of(conn: &Connection, field_id: &str) -> serde_json::Value {
    let raw: String = conn
        .query_row(
            "SELECT options FROM database_fields WHERE id = ?1",
            params![field_id],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn count_fields(conn: &Connection, view_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM database_fields WHERE database_view_id = ?1",
        params![view_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn view_of_field(conn: &Connection, field_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT database_view_id FROM database_fields WHERE id = ?1",
        params![field_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .unwrap()
}
