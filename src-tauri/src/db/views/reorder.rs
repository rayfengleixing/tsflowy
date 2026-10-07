use rusqlite::{params, Connection};

use super::super::models::ViewRow;
use super::super::{dberr, now_ms};
use super::crud::query_views;

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
