use rusqlite::{params, Connection};

use super::super::models::ViewRow;
use super::super::{dberr, now_ms};
use super::crud::query_views;
use super::trash::with_recursive_subtree;

// ---------- 移动 / 重排（tree.ts computeRenumber 的 Rust 镜像，单命令单事务） ----------

struct PositionUpdate {
    id: String,
    parent_id: Option<String>,
    position: i64,
}

/// parentId 下除 movedId 外的兄弟 id（按 position 排序；稳定排序与 JS 一致）
fn sibling_ids(views: &[ViewRow], parent_id: Option<&str>, moved_id: Option<&str>) -> Vec<String> {
    let mut pairs: Vec<(i64, String)> = views
        .iter()
        .filter(|v| v.parent_id.as_deref() == parent_id && Some(v.id.as_str()) != moved_id)
        .map(|v| (v.position, v.id.clone()))
        .collect();
    pairs.sort_by_key(|(p, _)| *p);
    pairs.into_iter().map(|(_, id)| id).collect()
}

/// 把 moved_id 放到 new_parent_id 下 index 位置，返回所有需更新的行。
/// 与 tree.ts computeRenumber 逐行为对齐：越界收敛、无变化短路、旧父级兄弟压缩。
fn compute_renumber(
    views: &[ViewRow],
    moved_id: &str,
    new_parent_id: Option<&str>,
    index: i64,
) -> Vec<PositionUpdate> {
    let Some(moving) = views.iter().find(|v| v.id == moved_id) else {
        return Vec::new();
    };
    let old_parent = moving.parent_id.clone();

    let mut new_ids = sibling_ids(views, new_parent_id, Some(moved_id));
    let idx = (index.max(0) as usize).min(new_ids.len());
    new_ids.insert(idx, moved_id.to_string());
    // 同父级且顺序不变 → 无需更新
    if old_parent.as_deref() == new_parent_id && new_ids == sibling_ids(views, new_parent_id, None)
    {
        return Vec::new();
    }

    let mut updates: Vec<PositionUpdate> = new_ids
        .iter()
        .enumerate()
        .map(|(i, id)| PositionUpdate {
            id: id.clone(),
            parent_id: new_parent_id.map(|s| s.to_string()),
            position: i as i64,
        })
        .collect();

    if old_parent.as_deref() != new_parent_id {
        for (i, id) in sibling_ids(views, old_parent.as_deref(), Some(moved_id))
            .into_iter()
            .enumerate()
        {
            updates.push(PositionUpdate {
                id,
                parent_id: old_parent.clone(),
                position: i as i64,
            });
        }
    }
    updates
}

/// 单事务移动：SELECT 全 workspace 视图（含 trash，同旧 db.ts；排除派生视图——它们 parent_id 为 NULL
/// 但不属于页面树）→ 后代环守卫（静默 no-op）→ compute_renumber → prepared statement 逐行 UPDATE。
pub fn move_view(
    conn: &Connection,
    view_id: &str,
    new_parent_id: Option<&str>,
    index: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(dberr("move view"))?;
    let views = query_views(
        &tx,
        "SELECT * FROM views WHERE workspace_id = (SELECT workspace_id FROM views WHERE id = ?1)
           AND source_id IS NULL",
        params![view_id],
        "move view",
    )?;

    // 防呆：目标不能是自身的后代（UI 已拦截，此处兜底）
    if let Some(np) = new_parent_id {
        let mut cursor = np.to_string();
        loop {
            if cursor == view_id {
                return Ok(());
            }
            match views
                .iter()
                .find(|v| v.id == cursor)
                .and_then(|v| v.parent_id.clone())
            {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    let updates = compute_renumber(&views, view_id, new_parent_id, index);
    if updates.is_empty() {
        return Ok(());
    }
    let t = now_ms();
    {
        let mut stmt = tx
            .prepare(
                "UPDATE views SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            )
            .map_err(dberr("move view"))?;
        for u in &updates {
            stmt.execute(params![u.parent_id, u.position, t, u.id])
                .map_err(dberr("move view"))?;
        }
    }
    tx.commit().map_err(dberr("move view (commit)"))?;
    Ok(())
}

/// 按 (workspace_id, parent_id) 取兄弟位。跨空间时不能只比 parent_id：
/// 每个空间的根级页面 parent_id 都是 NULL，只按它分组会把两个空间的根混进同一列重排。
fn ws_sibling_ids(
    views: &[ViewRow],
    workspace_id: &str,
    parent_id: Option<&str>,
    moved_id: Option<&str>,
) -> Vec<String> {
    let mut pairs: Vec<(i64, String)> = views
        .iter()
        .filter(|v| {
            v.workspace_id == workspace_id
                && v.parent_id.as_deref() == parent_id
                && Some(v.id.as_str()) != moved_id
        })
        .map(|v| (v.position, v.id.clone()))
        .collect();
    pairs.sort_by_key(|(p, _)| *p);
    pairs.into_iter().map(|(_, id)| id).collect()
}

fn view_by_id(conn: &Connection, id: &str, ctx: &'static str) -> Result<Option<ViewRow>, String> {
    let mut rows = query_views(conn, "SELECT * FROM views WHERE id = ?1", params![id], ctx)?;
    Ok(rows.pop())
}

/// 把页面连同整棵子树搬到另一个空间：目标侧按目标空间的兄弟插入、源侧压缩补位，
/// 再改写子树的 workspace_id。
///
/// 与同空间重排的两处本质差别：
/// 1. 位置分两侧算，目标空间里那一列的兄弟不在当前页面的树上；
/// 2. 光改根节点会留下「父在新空间、子还在旧空间」的半搬状态 —— 前端 buildTree 会把
///    找不到父节点的孤儿子树提成根，用户看到的是页面凭空冒出来，所以子树必须原子地一起走。
///    行详情文档（extra.row_detail，挂在数据库页下）与回收站里的后代同在该 CTE 覆盖内；
///    派生视图（多视图）parent_id 恒为 NULL，按 source_id 单独补一条。
pub fn move_view_to_workspace(
    conn: &Connection,
    view_id: &str,
    target_workspace_id: &str,
    target_parent_id: Option<&str>,
    index: i64,
) -> Result<(), String> {
    const CTX: &str = "move view across workspaces";
    let moved =
        view_by_id(conn, view_id, CTX)?.ok_or_else(|| format!("view not found: {view_id}"))?;
    if moved.source_id.is_some() {
        return Err(format!(
            "a derived view moves with its host page, not on its own: {view_id}"
        ));
    }
    // 回收站是按空间列的，跨空间搬一页等于往另一个空间的回收站里塞东西，恢复路径没人管
    if moved.is_trash != 0 {
        return Err(format!(
            "a page in the trash cannot change workspace: {view_id}"
        ));
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            params![target_workspace_id],
            |r| r.get(0),
        )
        .map_err(dberr("check target workspace"))?;
    if exists == 0 {
        return Err(format!("workspace not found: {target_workspace_id}"));
    }
    if let Some(parent_id) = target_parent_id {
        let parent = view_by_id(conn, parent_id, CTX)?
            .ok_or_else(|| format!("target parent not found: {parent_id}"))?;
        // 目标父级必须是目标空间里一个正经、不在回收站的页面，否则新位置在树查询里根本不可见
        if parent.workspace_id != target_workspace_id
            || parent.source_id.is_some()
            || parent.is_trash != 0
        {
            return Err(format!(
                "target parent is not a page in workspace {target_workspace_id}: {parent_id}"
            ));
        }
    }
    // 同空间只是换位置/重排：走原路径，免得同一组兄弟被目标侧和源侧各编一遍号
    if moved.workspace_id == target_workspace_id {
        return move_view(conn, view_id, target_parent_id, index);
    }

    let tx = conn.unchecked_transaction().map_err(dberr(CTX))?;
    // 两个空间的树内行都取（含 trash、含行详情文档，口径同 move_view）：
    // 目标侧算插入位，源侧算压缩位
    let views = query_views(
        &tx,
        "SELECT * FROM views WHERE (workspace_id = ?1 OR workspace_id = ?2) AND source_id IS NULL",
        params![moved.workspace_id, target_workspace_id],
        CTX,
    )?;

    let mut new_ids = ws_sibling_ids(&views, target_workspace_id, target_parent_id, Some(view_id));
    let idx = (index.max(0) as usize).min(new_ids.len());
    new_ids.insert(idx, view_id.to_string());
    let mut updates: Vec<PositionUpdate> = new_ids
        .iter()
        .enumerate()
        .map(|(i, id)| PositionUpdate {
            id: id.clone(),
            parent_id: target_parent_id.map(|s| s.to_string()),
            position: i as i64,
        })
        .collect();
    for (i, id) in ws_sibling_ids(
        &views,
        &moved.workspace_id,
        moved.parent_id.as_deref(),
        Some(view_id),
    )
    .into_iter()
    .enumerate()
    {
        updates.push(PositionUpdate {
            id,
            parent_id: moved.parent_id.clone(),
            position: i as i64,
        });
    }

    let t = now_ms();
    {
        let mut stmt = tx
            .prepare(
                "UPDATE views SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            )
            .map_err(dberr(CTX))?;
        for u in &updates {
            stmt.execute(params![u.parent_id, u.position, t, u.id])
                .map_err(dberr(CTX))?;
        }
    }
    let rewrite = |sql: &str, ctx: &'static str| {
        with_recursive_subtree(&tx, sql, view_id, Some(&target_workspace_id), ctx).map(|_| ())
    };
    rewrite(
        "UPDATE views SET workspace_id = ?2 WHERE id IN (SELECT id FROM sub)",
        "move subtree across workspaces",
    )?;
    rewrite(
        "UPDATE views SET workspace_id = ?2 WHERE source_id IN (SELECT id FROM sub)",
        "move derived views across workspaces",
    )?;
    tx.commit()
        .map_err(dberr("move view across workspaces (commit)"))?;
    Ok(())
}
