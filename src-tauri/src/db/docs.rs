use rusqlite::{params, Connection, OptionalExtension};

use super::models::DocRowOut;
use super::{dberr, now_ms};

pub fn get(conn: &Connection, view_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT content FROM documents WHERE view_id = ?1",
        params![view_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(dberr("get document"))
}

/// 整篇 UPSERT（与旧 documents.ts saveNow 同一条 SQL）；FTS 同步靠 trg_documents_fts_* 触发器。
pub fn save(conn: &Connection, view_id: &str, content: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO documents(view_id, content, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(view_id) DO UPDATE SET content = ?2, updated_at = ?3",
        params![view_id, content, now_ms()],
    )
    .map_err(dberr("save document"))?;
    Ok(())
}

/// mentions 启动回填用：全量文档行。
pub fn list_all(conn: &Connection) -> Result<Vec<DocRowOut>, String> {
    let mut stmt = conn
        .prepare("SELECT view_id, content FROM documents")
        .map_err(dberr("list documents"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DocRowOut {
                view_id: r.get(0)?,
                content: r.get(1)?,
            })
        })
        .map_err(dberr("list documents"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list documents"))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::views;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn
    }

    fn seed_view(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', NULL, ?2, 'document', '{}', 0, 1, 1)",
            params![id, name],
        )
        .unwrap();
    }

    #[test]
    fn get_missing_returns_none() {
        let conn = setup();
        assert_eq!(get(&conn, "nope").unwrap(), None);
    }

    #[test]
    fn save_upserts_and_fts_stays_in_sync() {
        let conn = setup();
        seed_view(&conn, "v1", "标题A");

        save(&conn, "v1", r#"{"content":"第一版"}"#).unwrap();
        assert_eq!(get(&conn, "v1").unwrap().unwrap(), r#"{"content":"第一版"}"#);

        // 同一 view 再次保存 → 覆盖；触发器同步刷新 FTS content 列
        save(&conn, "v1", r#"{"content":"第二版独特词组"}"#).unwrap();
        let fts_content: String = conn
            .query_row("SELECT content FROM documents_fts WHERE view_id = 'v1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts_content, r#"{"content":"第二版独特词组"}"#);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn view_delete_cascades_document_and_fts_row() {
        let conn = setup();
        seed_view(&conn, "v1", "标题A");
        save(&conn, "v1", "{}").unwrap();
        conn.execute("DELETE FROM views WHERE id = 'v1'", []).unwrap();
        let docs: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM documents_fts", [], |r| r.get(0)).unwrap();
        assert_eq!((docs, fts), (0, 0));
    }

    #[test]
    fn list_all_returns_every_row() {
        let conn = setup();
        seed_view(&conn, "a", "A");
        seed_view(&conn, "b", "B");
        save(&conn, "a", "{}").unwrap();
        save(&conn, "b", "{}").unwrap();
        let rows = list_all(&conn).unwrap();
        assert_eq!(rows.len(), 2);
    }

    // views::create 的默认 H1 内容行也走同一触发器，已在 views.rs 覆盖（create_document_seeds_content_row_and_fts）
    #[test]
    fn saved_content_is_searchable_via_trigram() {
        let conn = setup();
        seed_view(&conn, "v1", "标题A");
        save(&conn, "v1", r#"{"text":"今天天气不错适合散步"}"#).unwrap();
        let hits = super::super::search::search(&conn, "w1", "天气不错").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].view_id, "v1");
        assert!(hits[0].snippet.contains("<em>"), "{}", hits[0].snippet);
    }

    #[test]
    fn fts_title_hit_uses_trigger_synced_name() {
        let conn = setup();
        seed_view(&conn, "v1", "读书笔记汇总");
        save(&conn, "v1", r#"{"text":"无关内容"}"#).unwrap();
        let hits = super::super::search::search(&conn, "w1", "读书笔记").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "读书笔记汇总");
    }

    #[test]
    fn rename_view_updates_fts_title() {
        let conn = setup();
        seed_view(&conn, "v1", "旧名字");
        save(&conn, "v1", r#"{"text":"无关内容"}"#).unwrap();
        conn.execute("UPDATE views SET name = '全新标题' WHERE id = 'v1'", []).unwrap();
        let hits = super::super::search::search(&conn, "w1", "全新标题").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "全新标题");
    }

    #[test]
    fn views_purge_removes_fts_rows_too() {
        let conn = setup();
        views::create(&conn, "v1", "w1", None, "文档", "document", "{}").unwrap();
        save(&conn, "v1", r#"{"text":"独特内容串"}"#).unwrap();
        views::soft_delete(&conn, "v1").unwrap();
        views::purge(&conn, "v1").unwrap();
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM documents_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0);
    }
}
