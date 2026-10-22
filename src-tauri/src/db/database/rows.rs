// database_rows 领域函数（从 database/mod.rs 原样搬入，逻辑未改）。
// 跨域共用的 next_position 留在父模块。
use rusqlite::{params, Connection, OptionalExtension};

use super::super::models::{DatabaseRowRow, TrashRowOut};
use super::super::views::data_view_id;
use super::super::views::trash::{purge_within, with_recursive_subtree};
use super::super::{dberr, now_ms};
use super::next_position;

// ---------- 行 ----------

fn row_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseRowRow> {
    Ok(DatabaseRowRow {
        id: r.get(0)?,
        database_view_id: r.get(1)?,
        position: r.get(2)?,
        document_id: r.get(3)?,
        parent_id: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn list_rows(conn: &Connection, view_id: &str) -> Result<Vec<DatabaseRowRow>, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let mut stmt = conn
        .prepare(
            "SELECT id, database_view_id, position, document_id, parent_id, created_at, updated_at
             FROM database_rows WHERE database_view_id = ?1 AND is_trash = 0 ORDER BY position ASC",
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
/// parent_id 指向本表另一行；父行由前端从已加载的行里选，这里只挡明显非法的引用。
pub fn create_row(
    conn: &Connection,
    view_id: &str,
    id: &str,
    parent_id: Option<&str>,
) -> Result<DatabaseRowRow, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let position = next_position(conn, "database_rows", view_id)?;
    let t = now_ms();
    if let Some(pid) = parent_id {
        assert_parent_usable(conn, pid, None, view_id)?;
    }
    conn.execute(
        "INSERT INTO database_rows(id, database_view_id, position, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, view_id, position, parent_id, t],
    )
    .map_err(dberr("create row"))?;
    Ok(DatabaseRowRow {
        id: id.to_string(),
        database_view_id: view_id.to_string(),
        position,
        document_id: None,
        parent_id: parent_id.map(str::to_string),
        created_at: t,
        updated_at: t,
    })
}

/// 按 id 读单个行（行详情重开时需要最新 document_id）。
pub fn get_row(conn: &Connection, row_id: &str) -> Result<Option<DatabaseRowRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, database_view_id, position, document_id, parent_id, created_at, updated_at
             FROM database_rows WHERE id = ?1",
        )
        .map_err(dberr("get row"))?;
    let mut rows = stmt
        .query_map(params![row_id], row_from_row)
        .map_err(dberr("get row"))?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(dberr("get row")),
        None => Ok(None),
    }
}

/// 行层级最深 4 层（顶层算第 1 层）。子树再深就只是把表格变成缩进迷宫。
const MAX_ROW_LEVEL: i64 = 4;

/// 从 row_id 往上数祖先层数（自身算 1）。
/// UNION 去重让环也能终止，避免历史脏数据把递归 CTE 变成死循环。
fn ancestor_level(conn: &Connection, row_id: &str) -> Result<i64, String> {
    let level: i64 = conn
        .query_row(
            "WITH RECURSIVE up(id, lvl) AS (
               SELECT ?1, 1
               UNION
               SELECT r.parent_id, up.lvl + 1 FROM database_rows r JOIN up ON r.id = up.id
             )
             SELECT MAX(lvl) FROM up WHERE id IS NOT NULL",
            params![row_id],
            |r| r.get(0),
        )
        .map_err(dberr("row ancestors"))?;
    Ok(level)
}

/// 从 row_id 往下数的子树高度（自身算 0，无子行算 0）。
fn subtree_height(conn: &Connection, row_id: &str) -> Result<i64, String> {
    let height: i64 = conn
        .query_row(
            "WITH RECURSIVE down(id, lvl) AS (
               SELECT ?1, 0
               UNION
               SELECT r.id, down.lvl + 1 FROM database_rows r JOIN down ON r.parent_id = down.id
             )
             SELECT MAX(lvl) FROM down",
            params![row_id],
            |r| r.get(0),
        )
        .map_err(dberr("row subtree"))?;
    Ok(height)
}

/// 校验 parent_id 能不能作为 child_id（None=新建的行，还没有子树）的父行。
/// 同一张表、父行存在且不在回收站、不成环、搬完后深度不超限。
fn assert_parent_usable(
    conn: &Connection,
    parent_id: &str,
    child_id: Option<&str>,
    view_id: &str,
) -> Result<(), String> {
    if child_id == Some(parent_id) {
        return Err("row cannot be its own parent".into());
    }
    let (parent_view, parent_trash): (String, i64) = conn
        .query_row(
            "SELECT database_view_id, is_trash FROM database_rows WHERE id = ?1",
            params![parent_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr("parent row"))?
        .ok_or_else(|| "parent row not found".to_string())?;
    if parent_trash != 0 {
        return Err("parent row is in trash".into());
    }
    if parent_view != view_id {
        return Err("parent row is in another table".into());
    }
    let parent_level = ancestor_level(conn, parent_id)?;
    // 被搬的行下面还挂着整棵旧子树，最深的那条线也要一起算进限额
    let below = match child_id {
        Some(cid) => {
            // 环：新父行不能落在被搬行的子树里（从被搬行往下找新父行）
            let mut stmt = conn
                .prepare(
                    "WITH RECURSIVE down(id) AS (
                       SELECT ?1
                       UNION
                       SELECT r.id FROM database_rows r JOIN down ON r.parent_id = down.id
                     )
                     SELECT 1 FROM down WHERE id = ?2 LIMIT 1",
                )
                .map_err(dberr("row descendants"))?;
            let loops: Option<i64> = stmt
                .query_row(params![cid, parent_id], |r| r.get(0))
                .optional()
                .map_err(dberr("row descendants"))?;
            if loops.is_some() {
                return Err("row cannot be its own descendant".into());
            }
            subtree_height(conn, cid)?
        }
        None => 0,
    };
    if parent_level + 1 + below > MAX_ROW_LEVEL {
        return Err(format!("row depth exceeds limit of {MAX_ROW_LEVEL} levels"));
    }
    Ok(())
}

/// 改父行（None = 升到顶层）。层级限制在这里挡住环与超深，前端不必再猜。
pub fn set_row_parent(
    conn: &Connection,
    row_id: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    let (view_id, old_parent): (String, Option<String>) = conn
        .query_row(
            "SELECT database_view_id, parent_id FROM database_rows WHERE id = ?1",
            params![row_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr("set row parent (row)"))?
        .ok_or_else(|| "row not found".to_string())?;
    if parent_id == old_parent.as_deref() {
        return Ok(());
    }
    if let Some(pid) = parent_id {
        assert_parent_usable(conn, pid, Some(row_id), &view_id)?;
    }
    conn.execute(
        "UPDATE database_rows SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![parent_id, now_ms(), row_id],
    )
    .map_err(dberr("set row parent"))?;
    Ok(())
}

/// 绑定行详情文档 view（首次打开行详情时创建）。
pub fn set_row_document_id(
    conn: &Connection,
    row_id: &str,
    document_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE database_rows SET document_id = ?1 WHERE id = ?2",
        params![document_id, row_id],
    )
    .map_err(dberr("set row document"))?;
    Ok(())
}

/// 把视图内行的 position 压紧成 0..n-1（按现有 position，再按 id 定序）。
/// 行号列直接显示 position + 1（GridView），删除后不压紧会跳号；reorder 本就写 0..n-1，与此语义一致。
/// 回收站中的行不参与编号、也不改写它的 position：恢复时统一排队到可见行末尾（见 restore_row）。
fn compact_row_positions(tx: &Connection, view_id: &str) -> Result<(), String> {
    tx.execute(
        "WITH numbered AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1 AS rn
             FROM database_rows WHERE database_view_id = ?1 AND is_trash = 0
         )
         UPDATE database_rows
         SET position = (SELECT rn FROM numbered WHERE numbered.id = database_rows.id)
         WHERE database_view_id = ?1 AND is_trash = 0",
        params![view_id],
    )
    .map_err(dberr("compact row positions"))?;
    Ok(())
}

/// 行的删除标记连带它的行详情文档一起进出回收站。
/// 不这么做的话：搜索（documents_fts 只看 view.is_trash）和快照列表仍能翻出已删行的正文。
/// 行详情文档带 extra.row_detail 标记，页面树与页面回收站都按同一条件排除它，
/// 所以给它打上 is_trash 不会在「页面回收站」里冒出一条看不懂的条目。
fn move_row_document(
    tx: &Connection,
    document_id: &str,
    to_trash: bool,
    t: i64,
) -> Result<(), String> {
    if to_trash {
        with_recursive_subtree(
            tx,
            "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE id IN (SELECT id FROM sub) AND is_trash = 0",
            document_id,
            Some(&t),
            "trash row document",
        )?;
    } else {
        with_recursive_subtree(
            tx,
            "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE id IN (SELECT id FROM sub)",
            document_id,
            None,
            "restore row document",
        )?;
    }
    Ok(())
}

/// 进回收站（软删）。一个事务里完成：标记行 + 连带行详情文档 + 压紧剩余可见行。
/// 已在回收站里的行与不存在的 id 都不计数，重复调用幂等。
pub fn soft_delete_rows(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("soft delete rows"))?;
    let t = now_ms();
    let mut affected_views: Vec<String> = Vec::new();
    let mut n = 0;
    for id in ids {
        let row = tx
            .query_row(
                "SELECT database_view_id, document_id FROM database_rows WHERE id = ?1 AND is_trash = 0",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(dberr("soft delete rows (read row)"))?;
        let Some((view_id, document_id)) = row else {
            continue;
        };
        n += tx
            .execute(
                // updated_at 一并刷新：同步的变更水位读的是 MAX(database_rows.updated_at)
                "UPDATE database_rows SET is_trash = 1, deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![id, t],
            )
            .map_err(dberr("soft delete rows"))?;
        if let Some(doc) = document_id {
            move_row_document(&tx, &doc, true, t)?;
        }
        if !affected_views.contains(&view_id) {
            affected_views.push(view_id);
        }
    }
    for v in &affected_views {
        compact_row_positions(&tx, v)?;
    }
    tx.commit().map_err(dberr("soft delete rows (commit)"))?;
    Ok(n)
}

/// 从回收站恢复一行：行号排到可见行末尾（原 position 大概率已被压紧时占用，保留会撞号）。
/// 不在回收站里（或不存在）时报错，让前端明确知道这一行已经恢复过了。
pub fn restore_row(conn: &Connection, row_id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("restore row"))?;
    let row = tx
        .query_row(
            "SELECT database_view_id, document_id FROM database_rows WHERE id = ?1 AND is_trash = 1",
            params![row_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(dberr("restore row (read row)"))?;
    let Some((view_id, document_id)) = row else {
        return Err(format!("row not in trash: {row_id}"));
    };
    let t = now_ms();
    let position = next_position(&tx, "database_rows", &view_id)?;
    tx.execute(
        "UPDATE database_rows SET is_trash = 0, deleted_at = NULL, position = ?2, updated_at = ?3 WHERE id = ?1",
        params![row_id, position, t],
    )
    .map_err(dberr("restore row"))?;
    if let Some(doc) = document_id {
        move_row_document(&tx, &doc, false, t)?;
        // 页面回收站的清空可能已经把这份详情文档一起彻底删了（它也是普通 view）。
        // 悬空的 document_id 会让下次打开行详情报 "row detail view missing"，
        // 这里顺手清成 NULL，让前端按「首次打开」重建一页。
        tx.execute(
            "UPDATE database_rows SET document_id = NULL
             WHERE id = ?1 AND document_id IS NOT NULL AND document_id NOT IN (SELECT id FROM views)",
            params![row_id],
        )
        .map_err(dberr("restore row (clear dangling document)"))?;
    }
    tx.commit().map_err(dberr("restore row (commit)"))?;
    Ok(())
}

/// 彻底删除：真删行（cells 经 FK 级联，FTS 由触发器清理）并连带删掉行详情文档。
/// 不在回收站里的行同样能删——历史调用方（整表清空、复制视图回滚）走的就是这个语义。
pub fn purge_rows(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(dberr("purge rows"))?;
    let mut affected_views: Vec<String> = Vec::new();
    let mut n = 0;
    for id in ids {
        let row = tx
            .query_row(
                "SELECT database_view_id, document_id FROM database_rows WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(dberr("purge rows (read row)"))?;
        let Some((view_id, document_id)) = row else {
            continue;
        };
        if let Some(doc) = document_id {
            // 只删文档自身 + 已在回收站里的后代；用户后来恢复出回收站的子页改挂到宿主页，不陪葬
            purge_within(&tx, &doc)?;
        }
        n += tx
            .execute("DELETE FROM database_rows WHERE id = ?1", params![id])
            .map_err(dberr("purge rows"))?;
        if !affected_views.contains(&view_id) {
            affected_views.push(view_id);
        }
    }
    for v in &affected_views {
        compact_row_positions(&tx, v)?;
    }
    tx.commit().map_err(dberr("purge rows (commit)"))?;
    Ok(n)
}

/// 某张表的回收站内容（按删除时间倒序）。
/// title 走 database_cell_text（选项 id 已解析成选项名、公式/复选框有各自的显示口径），
/// 取该表第一个字段的显示文本，只用于列表辨认是哪一行。
pub fn list_trash_rows(conn: &Connection, view_id: &str) -> Result<Vec<TrashRowOut>, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.database_view_id, r.document_id, r.deleted_at,
                    COALESCE((
                      SELECT substr(t.txt, 1, 60)
                      FROM database_cell_text t
                      JOIN database_fields f ON f.id = t.field_id
                      WHERE t.row_id = r.id AND f.database_view_id = r.database_view_id
                      ORDER BY f.position ASC, f.id ASC LIMIT 1
                    ), '') AS title
             FROM database_rows r
             WHERE r.database_view_id = ?1 AND r.is_trash = 1
             ORDER BY r.deleted_at DESC, r.id DESC",
        )
        .map_err(dberr("list trash rows"))?;
    let rows = stmt
        .query_map(params![view_id], |r| {
            Ok(TrashRowOut {
                id: r.get(0)?,
                database_view_id: r.get(1)?,
                document_id: r.get(2)?,
                deleted_at: r.get(3)?,
                title: r.get(4)?,
            })
        })
        .map_err(dberr("list trash rows"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list trash rows"))?;
    Ok(rows)
}

/// 清空某张表的回收站，返回彻底删除的行数。
pub fn purge_trash_rows(conn: &Connection, view_id: &str) -> Result<usize, String> {
    let host = data_view_id(conn, view_id)?;
    let mut stmt = conn
        .prepare("SELECT id FROM database_rows WHERE database_view_id = ?1 AND is_trash = 1")
        .map_err(dberr("scan trash rows"))?;
    let ids = stmt
        .query_map(params![host], |r| r.get::<_, String>(0))
        .map_err(dberr("scan trash rows"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("scan trash rows"))?;
    // 先收集再删：purge_rows 内部删的是同一张表，边遍历游标边写会踩 SQLite 的未定义行为
    purge_rows(conn, &ids)
}

/// 跨空间清理过期回收站（页面回收站的同一套小时级定时器调用），返回彻底删除的行数。
pub fn purge_expired_trash_rows(conn: &Connection, deadline_ms: i64) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM database_rows
             WHERE is_trash = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        )
        .map_err(dberr("scan expired trash rows"))?;
    let ids = stmt
        .query_map(params![deadline_ms], |r| r.get::<_, String>(0))
        .map_err(dberr("scan expired trash rows"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("scan expired trash rows"))?;
    purge_rows(conn, &ids)
}

pub fn reorder_rows(conn: &Connection, view_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("reorder rows"))?;
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
