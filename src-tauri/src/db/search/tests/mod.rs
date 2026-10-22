// search 的用例：夹具与子模块声明（从 search.rs 的 tests 模块原样搬入，断言未改）。
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

mod cells;
mod query;
mod terms;
