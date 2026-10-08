//! 资源引用扫描：为「清理未引用资源」提供判定依据——哪些 assets 文件名仍被引用。
//!
//! 引用只可能出现在三处 JSON 文本里：文档正文（`documents.content`，图片 / 附件节点的 src）、
//! 视图配置（`views.extra`，页面封面图等）与数据库单元格（`database_cells.value`，附件字段
//! 存的 `[{name,path}]`）。这里刻意**不做 JSON 解析**，直接把整串返回，由上层做子串匹配：
//! 解析树只能覆盖已知节点类型，日后新增一种带 src 的节点就会漏判，而漏判的后果是把在用
//! 资源当孤儿删掉。资源名是纳秒时间戳（全库唯一），子串匹配足够可靠。

use rusqlite::Connection;

use super::dberr;

/// 全库中可能含有资源引用的 JSON 文本（文档正文 + 视图 extra + 数据库单元格）。
pub fn reference_blobs(conn: &Connection) -> Result<Vec<String>, String> {
    let mut out = Vec::new();

    let mut docs = conn
        .prepare("SELECT content FROM documents")
        .map_err(dberr("scan document contents"))?;
    let rows = docs
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(dberr("scan document contents"))?;
    for row in rows {
        out.push(row.map_err(dberr("scan document contents"))?);
    }
    drop(docs);

    let mut views = conn
        .prepare("SELECT extra FROM views")
        .map_err(dberr("scan view extras"))?;
    let rows = views
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(dberr("scan view extras"))?;
    for row in rows {
        out.push(row.map_err(dberr("scan view extras"))?);
    }
    drop(views);

    // 数据库单元格：附件字段的值是 [{name,path}]，path 指向 assets/ 下的文件；NULL 单元格跳过
    let mut cells = conn
        .prepare("SELECT value FROM database_cells WHERE value IS NOT NULL")
        .map_err(dberr("scan database cells"))?;
    let rows = cells
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(dberr("scan database cells"))?;
    for row in rows {
        out.push(row.map_err(dberr("scan database cells"))?);
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_blobs_collects_documents_views_and_database_cells() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();

        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1','w1','P','document','{\"cover\":\"assets/1.png\"}',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at)
             VALUES ('v1','{\"type\":\"doc\",\"content\":[{\"type\":\"image\",\"attrs\":{\"src\":\"assets/2.png\"}}]}',1)",
            [],
        )
        .unwrap();

        // 附件字段存在 database_cells.value 里：扫描必须覆盖，否则清理孤儿资源时会误删在用文件
        conn.execute(
            "INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v2','w1','表','grid','{}',1,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES ('f1','v2','附件','attachment','{\"kind\":\"none\"}',180,0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, document_id, created_at, updated_at)
             VALUES ('r1','v2',0,NULL,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_cells(row_id, field_id, value)
             VALUES ('r1','f1','[{\"name\":\"a.pdf\",\"path\":\"assets/3.pdf\"}]')",
            [],
        )
        .unwrap();

        let blobs = reference_blobs(&conn).unwrap();
        assert!(blobs.iter().any(|b| b.contains("assets/2.png")));
        assert!(blobs.iter().any(|b| b.contains("assets/1.png")));
        assert!(blobs.iter().any(|b| b.contains("assets/3.pdf")));
    }
}
