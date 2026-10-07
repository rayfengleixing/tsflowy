use rusqlite::{params, Connection};

use super::super::{dberr, now_ms};

fn with_recursive_subtree(
    conn: &Connection,
    body: &str,
    id: &str,
    extra: Option<i64>,
    ctx: &'static str,
) -> Result<usize, String> {
    let sql = format!(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM views WHERE id = ?1
           UNION ALL
           SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
         )
         {body}"
    );
    let n = match extra {
        Some(ts) => conn.execute(&sql, params![id, ts]),
        None => conn.execute(&sql, params![id]),
    }
    .map_err(dberr(ctx))?;
    Ok(n)
}

/// 软删：视图及其整个子树进回收站（含数据库表的派生视图，否则恢复时视图配置丢失）
pub fn soft_delete(conn: &Connection, id: &str) -> Result<(), String> {
    let t = now_ms();
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE id IN (SELECT id FROM sub)",
        id,
        Some(t),
        "soft delete view",
    )?;
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE source_id IN (SELECT id FROM sub)",
        id,
        Some(t),
        "soft delete derived views",
    )
    .map(|_| ())
}

/// 恢复：视图及其子树移出回收站（含派生视图）
pub fn restore(conn: &Connection, id: &str) -> Result<(), String> {
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE id IN (SELECT id FROM sub)",
        id,
        None,
        "restore view",
    )?;
    with_recursive_subtree(
        conn,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE source_id IN (SELECT id FROM sub)",
        id,
        None,
        "restore derived views",
    )
    .map(|_| ())
}

/// 彻底删除：只硬删回收站中的子树部分 + 被显式指定的根节点；
/// 子树里"已被单独恢复出回收站"的后代改挂到根节点的父级，不陪葬（回收站可以单独恢复子页，
/// 若这里按整棵子树硬删，会把已经回到树里的页面连同文档一起删除）。
/// documents/database_* 经 FK 级联 + FTS delete 触发器；派生视图经 views.source_id 的 FK 级联删除。
pub fn purge(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("purge view"))?;
    // 1) 回收站外的后代先改挂到根的父级（del = 将被删除的行；keep = 保留下来的行）
    tx.execute(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM views WHERE id = ?1
           UNION ALL
           SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
         ),
         del(id) AS (SELECT id FROM sub WHERE is_trash = 1 OR id = ?1),
         keep(id) AS (SELECT id FROM sub WHERE id NOT IN (SELECT id FROM del))
         UPDATE views
         SET parent_id = (SELECT parent_id FROM views WHERE id = ?1)
         WHERE id IN (
           SELECT k.id FROM keep k JOIN views kv ON kv.id = k.id
           WHERE kv.parent_id IN (SELECT id FROM del)
         )",
        params![id],
    )
    .map_err(dberr("purge view (reparent survivors)"))?;
    // 2) 删除回收站部分
    tx.execute(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM views WHERE id = ?1
           UNION ALL
           SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
         )
         DELETE FROM views WHERE id IN (SELECT id FROM sub WHERE is_trash = 1 OR id = ?1)",
        params![id],
    )
    .map_err(dberr("purge view (delete)"))?;
    tx.commit().map_err(dberr("purge view (commit)"))?;
    Ok(())
}

pub fn purge_trash(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("purge trash"))?;
    tx.execute(
        "DELETE FROM views WHERE workspace_id = ?1 AND is_trash = 1",
        params![workspace_id],
    )
    .map_err(dberr("purge trash"))?;
    reparent_orphans_in_workspace(&tx, workspace_id)?;
    tx.commit().map_err(dberr("purge trash (commit)"))?;
    Ok(())
}

/// 永久删除回收站中 deleted_at 早于 deadline_ms（毫秒时间戳）的视图，返回删除行数（30 天自动清空）
pub fn purge_expired_trash(
    conn: &Connection,
    workspace_id: &str,
    deadline_ms: i64,
) -> Result<i64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("purge expired trash"))?;
    let n = tx
        .execute(
            "DELETE FROM views WHERE workspace_id = ?1 AND is_trash = 1
               AND deleted_at IS NOT NULL AND deleted_at < ?2",
            params![workspace_id, deadline_ms],
        )
        .map_err(dberr("purge expired trash"))?;
    reparent_orphans_in_workspace(&tx, workspace_id)?;
    tx.commit().map_err(dberr("purge expired trash (commit)"))?;
    Ok(n as i64)
}

/// 把"父已被永久删除、自己还在树里"的页面挂回根级，避免悬挂 parent_id
/// （回收站支持单独恢复子页：父被清空后子页会落在这种情况）
fn reparent_orphans_in_workspace(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE views SET parent_id = NULL
         WHERE workspace_id = ?1 AND is_trash = 0 AND parent_id IS NOT NULL
           AND parent_id NOT IN (SELECT id FROM views)",
        params![workspace_id],
    )
    .map_err(dberr("reparent orphans"))?;
    Ok(())
}
