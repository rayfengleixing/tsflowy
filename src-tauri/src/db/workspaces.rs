use rusqlite::{params, Connection};

use super::models::WorkspaceRow;
use super::{dberr, now_ms};

fn row_to_workspace(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: r.get("id")?,
        name: r.get("name")?,
        icon: r.get("icon")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<WorkspaceRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, icon, created_at, updated_at FROM workspaces ORDER BY created_at ASC")
        .map_err(dberr("list workspaces"))?;
    let rows = stmt
        .query_map([], row_to_workspace)
        .map_err(dberr("list workspaces"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list workspaces"))?;
    Ok(rows)
}

pub fn create(conn: &Connection, id: &str, name: &str) -> Result<WorkspaceRow, String> {
    let t = now_ms();
    conn.execute(
        "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![id, name, t],
    )
    .map_err(dberr("create workspace"))?;
    Ok(WorkspaceRow {
        id: id.to_string(),
        name: name.to_string(),
        icon: None,
        created_at: t,
        updated_at: t,
    })
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_ms(), id],
    )
    .map_err(dberr("rename workspace"))?;
    Ok(())
}

pub fn set_icon(conn: &Connection, id: &str, icon: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE workspaces SET icon = ?1, updated_at = ?2 WHERE id = ?3",
        params![icon, now_ms(), id],
    )
    .map_err(dberr("set workspace icon"))?;
    Ok(())
}

/// 级联删除空间及其下全部视图/文档（FK ON DELETE CASCADE）
pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])
        .map_err(dberr("remove workspace"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        super::super::apply_pragmas(&conn).unwrap();
        conn
    }

    #[test]
    fn remove_cascades_to_views_and_documents() {
        let conn = setup();
        create(&conn, "w1", "WS").unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1', 'w1', NULL, 'doc', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES ('v1', '{\"type\":\"doc\"}', 1)",
            [],
        )
        .unwrap();

        remove(&conn, "w1").unwrap();

        for (table, name) in [("workspaces", "w1"), ("views", "v1")] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"), params![name], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} cascade");
        }
        let docs: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
        assert_eq!(docs, 0, "documents cascade");
    }

    #[test]
    fn list_orders_by_created_at() {
        let conn = setup();
        create(&conn, "w2", "second").unwrap();
        create(&conn, "w1", "first").unwrap(); // created_at 更大 → 排后面
        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|w| w.id).collect();
        assert_eq!(ids, vec!["w2", "w1"]);
    }
}
