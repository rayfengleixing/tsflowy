use rusqlite::{params, Connection};

use super::super::{dberr, now_ms};

/// 对「视图 + 其子树」跑一条递归 CTE 语句。对外可见供数据库行回收站复用：
/// 行详情文档挂在宿主视图下，行进/出回收站要连它一起搬，而它本身是普通视图行。
/// 只做单条 execute，不开事务——调用方负责把多次改动包进同一个 tx。
pub(crate) fn with_recursive_subtree(
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
/// 两条 UPDATE 必须同事务：中途失败会留下"父在回收站、派生视图不在"的半删状态。
pub fn soft_delete(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("soft delete view"))?;
    let t = now_ms();
    with_recursive_subtree(
        &tx,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE id IN (SELECT id FROM sub)",
        id,
        Some(t),
        "soft delete view",
    )?;
    with_recursive_subtree(
        &tx,
        "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE source_id IN (SELECT id FROM sub)",
        id,
        Some(t),
        "soft delete derived views",
    )?;
    tx.commit().map_err(dberr("soft delete view (commit)"))
}

/// 恢复：视图及其子树移出回收站（含派生视图）。同事务，理由同 soft_delete。
pub fn restore(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("restore view"))?;
    with_recursive_subtree(
        &tx,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE id IN (SELECT id FROM sub)",
        id,
        None,
        "restore view",
    )?;
    with_recursive_subtree(
        &tx,
        "UPDATE views SET is_trash = 0, deleted_at = NULL WHERE source_id IN (SELECT id FROM sub)",
        id,
        None,
        "restore derived views",
    )?;
    tx.commit().map_err(dberr("restore view (commit)"))
}

/// 彻底删除：见 [`purge_within`]。
pub fn purge(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("purge view"))?;
    purge_within(&tx, id)?;
    tx.commit().map_err(dberr("purge view (commit)"))?;
    Ok(())
}

/// 彻底删除的主体（不开事务，可在调用方事务内复用）：
/// 只硬删回收站中的子树部分 + 被显式指定的根节点；
/// 子树里"已被单独恢复出回收站"的后代改挂到根节点的父级，不陪葬（回收站可以单独恢复子页，
/// 若这里按整棵子树硬删，会把已经回到树里的页面连同文档一起删除）。
/// documents/database_* 经 FK 级联 + FTS delete 触发器；派生视图经 views.source_id 的 FK 级联删除。
pub(crate) fn purge_within(conn: &Connection, id: &str) -> Result<(), String> {
    // 1) 回收站外的后代先改挂到根的父级（del = 将被删除的行；keep = 保留下来的行）
    conn.execute(
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
    conn.execute(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM views WHERE id = ?1
           UNION ALL
           SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
         )
         DELETE FROM views WHERE id IN (SELECT id FROM sub WHERE is_trash = 1 OR id = ?1)",
        params![id],
    )
    .map_err(dberr("purge view (delete)"))?;
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

/// 跨空间清理过期回收站（Rust 侧开机兜底，见 commands::files::run_expired_trash_sweep）。
/// 前端的定时器只管当前打开的那个工作区，本机从没点开过的工作区会一直挂着过期项。
pub fn purge_expired_trash_all(conn: &Connection, deadline_ms: i64) -> Result<i64, String> {
    let ids = super::super::workspaces::list(conn)?
        .into_iter()
        .map(|w| w.id)
        .collect::<Vec<String>>();
    let mut total = 0i64;
    for id in &ids {
        total += purge_expired_trash(conn, id, deadline_ms)?;
    }
    Ok(total)
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
