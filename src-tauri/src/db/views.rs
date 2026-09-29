use rusqlite::{params, Connection, OptionalExtension};

use super::models::{DatabaseFieldRow, DatabaseRowRow, DocRowOut, ViewRow};
use super::{dberr, now_ms};

fn row_to_view(r: &rusqlite::Row<'_>) -> rusqlite::Result<ViewRow> {
    Ok(ViewRow {
        id: r.get("id")?,
        workspace_id: r.get("workspace_id")?,
        parent_id: r.get("parent_id")?,
        name: r.get("name")?,
        icon: r.get("icon")?,
        layout: r.get("layout")?,
        extra: r.get("extra")?,
        position: r.get("position")?,
        is_favorite: r.get("is_favorite")?,
        is_trash: r.get("is_trash")?,
        deleted_at: r.get("deleted_at")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        visited_at: r.get("visited_at")?,
        source_id: r.get("source_id")?,
        tags: r.get("tags")?,
    })
}

fn query_views(
    conn: &Connection,
    sql: &str,
    p: impl rusqlite::Params,
    ctx: &'static str,
) -> Result<Vec<ViewRow>, String> {
    let mut stmt = conn.prepare(sql).map_err(dberr(ctx))?;
    let rows = stmt
        .query_map(p, row_to_view)
        .map_err(dberr(ctx))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr(ctx))?;
    Ok(rows)
}

/// 树 / 回收站 / 最近访问的可见性口径：行详情文档与派生视图（多视图）都不是"页面"，一律排除。
const VISIBLE_IN_TREE: &str = " AND json_extract(extra, '$.row_detail') IS NOT 1 AND source_id IS NULL";

pub fn list_by_workspace(conn: &Connection, workspace_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        &format!(
            "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 0{VISIBLE_IN_TREE} ORDER BY position ASC"
        ),
        params![workspace_id],
        "list views",
    )
}

pub fn list_trash(conn: &Connection, workspace_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        &format!(
            "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 1{VISIBLE_IN_TREE} ORDER BY deleted_at DESC"
        ),
        params![workspace_id],
        "list trash",
    )
}

pub fn list_recent(conn: &Connection, workspace_id: &str, limit: i64) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        &format!(
            "SELECT * FROM views WHERE workspace_id = ?1 AND is_trash = 0 AND visited_at IS NOT NULL\
             {VISIBLE_IN_TREE} ORDER BY visited_at DESC LIMIT ?2"
        ),
        params![workspace_id, limit],
        "list recent views",
    )
}

/// 一张表的全部视图（宿主 + 派生），供页面内的视图标签栏使用。
/// 宿主恒排第一：它的 position 是树里的排序位，与派生视图的 position 空间互不相干。
pub fn list_for_source(conn: &Connection, source_id: &str) -> Result<Vec<ViewRow>, String> {
    query_views(
        conn,
        "SELECT * FROM views WHERE (id = ?1 OR source_id = ?1) AND is_trash = 0
         ORDER BY (source_id IS NULL) DESC, position ASC",
        params![source_id],
        "list views of source",
    )
}

/// 数据宿主解析：派生视图一律折算到宿主 id —— fields/rows/cells 只挂在宿主上。
/// source_id 创建后不可变（无写入路径），故各入口查一次即可，无需缓存。
/// 视图行不存在时原样返回：保持旧行为（查询得到空集），避免已删视图的残留标签页弹错。
pub fn data_view_id(conn: &Connection, view_id: &str) -> Result<String, String> {
    let resolved: Option<String> = conn
        .query_row(
            "SELECT COALESCE(source_id, id) FROM views WHERE id = ?1",
            params![view_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr("resolve data view"))?;
    Ok(resolved.unwrap_or_else(|| view_id.to_string()))
}

pub fn touch_visited(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE views SET visited_at = ?1 WHERE id = ?2", params![now_ms(), id])
        .map_err(dberr("touch visited"))?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<ViewRow>, String> {
    conn.query_row("SELECT * FROM views WHERE id = ?1", params![id], row_to_view)
        .optional()
        .map_err(dberr("get view"))
}

/// 单事务：同级 MAX(position)+1 → INSERT views → document 布局再插默认内容行（H1 标题 + 分割线，
/// 前端 document-structure-lock 锁定二者；documents_fts 的 insert 触发器随之生效）。
///
/// `source_id = Some(host)` 建的是宿主表的一个派生视图（多视图）：不进树（parent_id 强制 NULL）、
/// position 在"该宿主的视图列表"内递增、不碰宿主的树内 position。
pub fn create(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    parent_id: Option<&str>,
    name: &str,
    layout: &str,
    extra: &str,
    source_id: Option<&str>,
) -> Result<ViewRow, String> {
    if source_id.is_some() && layout == "document" {
        return Err("a derived view of a database cannot use the document layout".to_string());
    }
    let t = now_ms();
    let tx = conn.unchecked_transaction().map_err(dberr("create view"))?;
    let parent_id = match source_id {
        // 派生视图不属于页面树
        Some(_) => None,
        None => parent_id,
    };
    let position: i64 = match source_id {
        Some(host) => {
            // 宿主必须是已存在的宿主（不允许派生视图再挂派生视图，否则数据归属要递归解析）
            let is_host: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM views WHERE id = ?1 AND source_id IS NULL",
                    params![host],
                    |r| r.get(0),
                )
                .map_err(dberr("create derived view"))?;
            if is_host == 0 {
                return Err(format!("database view not found: {host}"));
            }
            tx.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE source_id = ?1",
                params![host],
                |r| r.get(0),
            )
            .map_err(dberr("create derived view"))?
        }
        None => tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE workspace_id = ?1 AND parent_id IS ?2",
                params![workspace_id, parent_id],
                |r| r.get(0),
            )
            .map_err(dberr("create view"))?,
    };
    tx.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at, source_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
        params![id, workspace_id, parent_id, name, layout, extra, position, t, source_id],
    )
    .map_err(dberr("create view"))?;
    if layout == "document" {
        // 默认结构：首行 H1 标题 + 第二行分割线（前端 document-structure-lock 锁定二者不可修改）
        let content = format!(
            r#"{{"type":"doc","content":[{{"type":"heading","attrs":{{"level":1}},"content":[{{"type":"text","text":{}}}]}},{{"type":"horizontalRule"}}]}}"#,
            serde_json::to_string(name).map_err(|e| format!("encode doc content: {e}"))?,
        );
        tx.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES (?1, ?2, ?3)",
            params![id, content, t],
        )
        .map_err(dberr("create view document"))?;
    }
    tx.commit().map_err(dberr("create view (commit)"))?;
    Ok(ViewRow {
        id: id.to_string(),
        workspace_id: workspace_id.to_string(),
        parent_id: parent_id.map(|s| s.to_string()),
        name: name.to_string(),
        icon: None,
        layout: layout.to_string(),
        extra: extra.to_string(),
        position,
        is_favorite: 0,
        is_trash: 0,
        deleted_at: None,
        created_at: t,
        updated_at: t,
        visited_at: None,
        source_id: source_id.map(|s| s.to_string()),
        tags: "[]".to_string(),
    })
}

/// 深拷贝一棵页面子树：副本挂在源节点的同一父级下、排在同级末尾，子树结构/名称/图标/正文/
/// 页面属性/数据库字段·行·单元格整体复刻；收藏、回收站、最近访问、历史快照不继承。
///
/// - 根节点 id 由调用方（前端 newId()）传入，后代按 `{new_id}_{序号}` 派生——项目没有引入
///   uuid 依赖，而 id 只要求全局唯一，派生串不会与任何前端生成的 id 相撞。
/// - 子树按 parent_id 展开，因此挂在数据库页面下的行详情文档（extra.row_detail）同样会被复制，
///   复制出来的行经 id 映射继续指向各自的副本文档。
/// - 派生视图（多视图，source_id 非空）parent_id 为 NULL、不属于页面树，不在复制范围内：
///   副本数据库只保留源根当前的 layout。
/// - created_at / last_edited_at 的单元格不搬运，交给 002 的触发器在插行时写成新时间。
/// - 单事务完成，任一步失败整体回滚；副本正文一并返回，供调用方重建 mentions 反链索引。
pub fn duplicate(
    conn: &Connection,
    src_id: &str,
    new_id: &str,
    name: &str,
) -> Result<(ViewRow, Vec<DocRowOut>), String> {
    let src = match get(conn, src_id)? {
        Some(v) => v,
        None => return Err(format!("view not found: {src_id}")),
    };
    // 派生视图的数据挂在宿主上，复制它只会得到一张空表，直接拒绝
    if src.source_id.is_some() {
        return Err(format!("cannot duplicate a derived view: {src_id}"));
    }

    let t = now_ms();
    let tx = conn.unchecked_transaction().map_err(dberr("duplicate view"))?;

    // 副本排在同级末尾（与 create 同一口径）
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE workspace_id = ?1 AND parent_id IS ?2",
            params![src.workspace_id, src.parent_id],
            |r| r.get(0),
        )
        .map_err(dberr("duplicate view"))?;

    // 第一遍：建视图行，同时积累 旧 id → 新 id 映射（后两遍都要用）
    let mut pairs: Vec<(String, String)> = vec![(src_id.to_string(), new_id.to_string())];
    tx.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, icon, layout, extra, position,
                            is_favorite, is_trash, deleted_at, created_at, updated_at, visited_at, source_id, tags)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, NULL, ?9, ?9, NULL, NULL, ?10)",
        params![
            new_id,
            src.workspace_id,
            src.parent_id,
            name,
            src.icon,
            src.layout,
            src.extra,
            position,
            t,
            src.tags
        ],
    )
    .map_err(dberr("duplicate view"))?;

    let mut seq = 0usize;
    let mut cursor = 0usize;
    while cursor < pairs.len() {
        let (old_id, new_vid) = pairs[cursor].clone();
        cursor += 1;
        let children = query_views(
            &tx,
            "SELECT * FROM views WHERE parent_id = ?1 ORDER BY position ASC",
            params![old_id],
            "duplicate view (children)",
        )?;
        for c in children {
            seq += 1;
            let child_new = format!("{new_id}_{seq}");
            tx.execute(
                "INSERT INTO views(id, workspace_id, parent_id, name, icon, layout, extra, position,
                                    is_favorite, is_trash, deleted_at, created_at, updated_at, visited_at, source_id, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, NULL, ?9, ?9, NULL, NULL, ?10)",
                params![
                    child_new,
                    c.workspace_id,
                    new_vid,
                    c.name,
                    c.icon,
                    c.layout,
                    c.extra,
                    c.position,
                    t,
                    c.tags
                ],
            )
            .map_err(dberr("duplicate view"))?;
            pairs.push((c.id, child_new));
        }
    }

    // 第二遍：正文与页面属性。documents 的 insert 触发器顺带把副本写进 FTS 索引
    let mut copied_docs: Vec<DocRowOut> = Vec::new();
    for (old_id, new_vid) in &pairs {
        let content: Option<String> = tx
            .query_row("SELECT content FROM documents WHERE view_id = ?1", params![old_id], |r| r.get(0))
            .optional()
            .map_err(dberr("duplicate view document"))?;
        if let Some(content) = content {
            tx.execute(
                "INSERT INTO documents(view_id, content, updated_at) VALUES (?1, ?2, ?3)",
                params![new_vid, content, t],
            )
            .map_err(dberr("duplicate view document"))?;
            copied_docs.push(DocRowOut {
                view_id: new_vid.clone(),
                content,
            });
        }
        tx.execute(
            "INSERT INTO page_properties(view_id, key, value, field_type, position)
             SELECT ?1, key, value, field_type, position FROM page_properties WHERE view_id = ?2",
            params![new_vid, old_id],
        )
        .map_err(dberr("duplicate view properties"))?;
    }

    // 第三遍：数据库字段 / 行 / 单元格（只有宿主页面才带数据）。字段与行都要重映射 id，
    // 单元格值原样搬运，database_cells 的 insert 触发器把文本同步进 database_fts。
    for (old_id, new_vid) in &pairs {
        let fields: Vec<DatabaseFieldRow> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, database_view_id, name, field_type, options, width, is_hidden, position
                     FROM database_fields WHERE database_view_id = ?1 ORDER BY position ASC",
                )
                .map_err(dberr("duplicate view fields"))?;
            let mapped = stmt
                .query_map(params![old_id], |r| {
                    Ok(DatabaseFieldRow {
                        id: r.get(0)?,
                        database_view_id: r.get(1)?,
                        name: r.get(2)?,
                        field_type: r.get(3)?,
                        options: r.get(4)?,
                        width: r.get(5)?,
                        is_hidden: r.get(6)?,
                        position: r.get(7)?,
                    })
                })
                .map_err(dberr("duplicate view fields"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(dberr("duplicate view fields"))?;
            mapped
        };

        let mut field_map: Vec<(String, String)> = Vec::new();
        for (i, f) in fields.iter().enumerate() {
            let new_fid = format!("{new_vid}_f{i}");
            tx.execute(
                "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![new_fid, new_vid, f.name, f.field_type, f.options, f.width, f.is_hidden, f.position],
            )
            .map_err(dberr("duplicate view fields"))?;
            // 时间戳字段的单元格交给触发器写成新时间，不搬源值
            if f.field_type != "created_at" && f.field_type != "last_edited_at" {
                field_map.push((f.id.clone(), new_fid));
            }
        }

        let rows: Vec<DatabaseRowRow> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, database_view_id, position, document_id, created_at, updated_at
                     FROM database_rows WHERE database_view_id = ?1 ORDER BY position ASC",
                )
                .map_err(dberr("duplicate view rows"))?;
            let mapped = stmt
                .query_map(params![old_id], |r| {
                    Ok(DatabaseRowRow {
                        id: r.get(0)?,
                        database_view_id: r.get(1)?,
                        position: r.get(2)?,
                        document_id: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                })
                .map_err(dberr("duplicate view rows"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(dberr("duplicate view rows"))?;
            mapped
        };

        for (i, r) in rows.iter().enumerate() {
            let new_rid = format!("{new_vid}_r{i}");
            let new_doc = r
                .document_id
                .as_ref()
                .and_then(|d| pairs.iter().find(|(old, _)| old == d).map(|(_, new)| new.clone()));
            tx.execute(
                "INSERT INTO database_rows(id, database_view_id, position, document_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![new_rid, new_vid, r.position, new_doc, t],
            )
            .map_err(dberr("duplicate view rows"))?;
            for (old_fid, new_fid) in &field_map {
                tx.execute(
                    "INSERT INTO database_cells(row_id, field_id, value)
                     SELECT ?1, ?2, value FROM database_cells WHERE row_id = ?3 AND field_id = ?4",
                    params![new_rid, new_fid, r.id, old_fid],
                )
                .map_err(dberr("duplicate view cells"))?;
            }
        }
    }

    let view = get(&tx, new_id)?.ok_or_else(|| format!("duplicate view lost: {new_id}"))?;
    tx.commit().map_err(dberr("duplicate view (commit)"))?;
    Ok((view, copied_docs))
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE views SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_ms(), id],
    )
    .map_err(dberr("rename view"))?;
    Ok(())
}

pub fn set_icon(conn: &Connection, id: &str, icon: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE views SET icon = ?1, updated_at = ?2 WHERE id = ?3",
        params![icon, now_ms(), id],
    )
    .map_err(dberr("set view icon"))?;
    Ok(())
}

/// 收藏/取消收藏（侧边栏收藏区置顶显示）
pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE views SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i64, now_ms(), id],
        )
        .map_err(dberr("set view favorite"))?;
    if n == 0 {
        return Err(format!("view not found: {id}"));
    }
    Ok(())
}

/// 设置页面标签（整体覆写 JSON 数组；空数组 = 清空标签）。
/// 这里校验 + 去重 + 规整成紧凑 JSON，前端直接读字符串。
pub fn set_tags(conn: &Connection, id: &str, tags: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(tags).map_err(|e| format!("invalid tags JSON: {e}"))?;
    let serde_json::Value::Array(arr) = parsed else {
        return Err("tags must be a JSON array".to_string());
    };
    let mut seen: Vec<String> = Vec::new();
    for v in &arr {
        let Some(s) = v.as_str() else {
            return Err("tags must be strings".to_string());
        };
        let trimmed = s.trim();
        if trimmed.is_empty() || seen.iter().any(|x| x == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
    }
    let normalized = serde_json::to_string(&seen).map_err(|e| format!("encode tags: {e}"))?;
    let n = conn
        .execute(
            "UPDATE views SET tags = ?1, updated_at = ?2 WHERE id = ?3",
            params![normalized, now_ms(), id],
        )
        .map_err(dberr("set view tags"))?;
    if n == 0 {
        return Err(format!("view not found: {id}"));
    }
    Ok(())
}

/// 整体覆写视图 extra（视图模式/筛选/排序/看板分组字段/日历日期字段等显示配置）。
/// 合并语义在前端做（读改写整份 extra），这里只校验来料必须是 JSON 对象，
/// 以免把 row_detail 之类的既有标记冲成不可解析文本。
pub fn update_extra(conn: &Connection, id: &str, extra: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(extra).map_err(|e| format!("invalid extra JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("extra must be a JSON object".to_string());
    }
    let n = conn
        .execute(
            "UPDATE views SET extra = ?1, updated_at = ?2 WHERE id = ?3",
            params![extra, now_ms(), id],
        )
        .map_err(dberr("update view extra"))?;
    if n == 0 {
        return Err(format!("view not found: {id}"));
    }
    Ok(())
}

fn with_recursive_subtree(conn: &Connection, body: &str, id: &str, extra: Option<i64>, ctx: &'static str) -> Result<usize, String> {
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
pub fn purge_expired_trash(conn: &Connection, workspace_id: &str, deadline_ms: i64) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(dberr("purge expired trash"))?;
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
    if old_parent.as_deref() == new_parent_id && new_ids == sibling_ids(views, new_parent_id, None) {
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
            match views.iter().find(|v| v.id == cursor).and_then(|v| v.parent_id.clone()) {
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
            .prepare("UPDATE views SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4")
            .map_err(dberr("move view"))?;
        for u in &updates {
            stmt.execute(params![u.parent_id, u.position, t, u.id])
                .map_err(dberr("move view"))?;
        }
    }
    tx.commit().map_err(dberr("move view (commit)"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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

    /// 与 tree.test.ts 同款 fixture：r1/r2/r3 根级（0-2），c1/c2/c3 在 r1 下（0-2）
    fn seed_default_fixture(conn: &Connection) {
        for (id, parent, pos) in [
            ("r1", None, 0),
            ("r2", None, 1),
            ("r3", None, 2),
            ("c1", Some("r1"), 0),
            ("c2", Some("r1"), 1),
            ("c3", Some("r1"), 2),
        ] {
            conn.execute(
                "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
                 VALUES (?1, 'w1', ?2, ?1, 'document', '{}', ?3, 1, 1)",
                params![id, parent, pos],
            )
            .unwrap();
        }
    }

    /// id → (parent_id, position)，按 id 排序便于整体断言
    fn layout(conn: &Connection) -> BTreeMap<String, (Option<String>, i64)> {
        let mut stmt = conn
            .prepare("SELECT id, parent_id, position FROM views")
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows.into_iter().map(|(id, p, pos)| (id, (p, pos))).collect()
    }

    #[test]
    fn move_same_parent_reorder() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c3", Some("r1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c3"], (Some("r1".into()), 0));
        assert_eq!(l["c1"], (Some("r1".into()), 1));
        assert_eq!(l["c2"], (Some("r1".into()), 2));
        assert_eq!(l["r1"], (None, 0));
    }

    #[test]
    fn move_cross_parent_index_clamped_to_end() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c1", None, 99).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c1"], (None, 3)); // 追加到根级末尾
        assert_eq!(l["r1"], (None, 0)); // 旧父级保持
        assert_eq!(l["c2"], (Some("r1".into()), 0)); // 旧父级兄弟压缩
        assert_eq!(l["c3"], (Some("r1".into()), 1));
        assert_eq!(l["r2"], (None, 1));
    }

    #[test]
    fn move_cross_parent_head() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "r3", Some("r1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["r3"], (Some("r1".into()), 0));
        assert_eq!(l["c1"], (Some("r1".into()), 1));
        assert_eq!(l["c2"], (Some("r1".into()), 2));
        assert_eq!(l["c3"], (Some("r1".into()), 3));
        assert_eq!(l["r1"], (None, 0));
        assert_eq!(l["r2"], (None, 1));
    }

    #[test]
    fn move_to_root_middle() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c2", None, 1).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c2"], (None, 1));
        assert_eq!(l["r2"], (None, 2));
        assert_eq!(l["r3"], (None, 3));
        assert_eq!(l["c1"], (Some("r1".into()), 0));
    }

    #[test]
    fn move_to_same_position_is_noop() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "c2", Some("r1"), 1).unwrap();
        let l = layout(&conn);
        assert_eq!(l["c2"], (Some("r1".into()), 1));
        assert_eq!(l["c1"], (Some("r1".into()), 0));
        assert_eq!(l["c3"], (Some("r1".into()), 2));
    }

    #[test]
    fn move_into_own_descendant_is_silent_noop() {
        let conn = setup();
        seed_default_fixture(&conn);
        // c1 是 r1 的后代：环守卫必须静默拒绝
        move_view(&conn, "r1", Some("c1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["r1"], (None, 0));
        assert_eq!(l["c1"], (Some("r1".into()), 0));
        assert_eq!(l["c2"], (Some("r1".into()), 1));
        assert_eq!(l["c3"], (Some("r1".into()), 2));
    }

    #[test]
    fn move_unknown_target_is_noop() {
        let conn = setup();
        seed_default_fixture(&conn);
        move_view(&conn, "ghost", None, 0).unwrap();
        assert_eq!(layout(&conn).len(), 6);
    }

    #[test]
    fn create_document_seeds_content_row_and_fts() {
        let conn = setup();
        let name = r#"He said "hi" \ ok"#;
        let v = create(&conn, "v1", "w1", None, name, "document", "{}", None).unwrap();
        assert_eq!(v.position, 0);
        assert_eq!(v.is_trash, 0);
        let content: String = conn
            .query_row("SELECT content FROM documents WHERE view_id = 'v1'", [], |r| r.get(0))
            .unwrap();
        // 默认结构：H1 标题 + 分割线（与前端 document-structure-lock 的保护区一致）
        assert_eq!(
            content,
            r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"He said \"hi\" \\ ok"}]},{"type":"horizontalRule"}]}"#
        );
        // documents INSERT 触发器已写 FTS
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM documents_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 1);
    }

    #[test]
    fn create_grid_has_no_document_row() {
        let conn = setup();
        create(&conn, "v1", "w1", None, "grid", "grid", "{}", None).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn create_position_increments_per_parent() {
        let conn = setup();
        create(&conn, "a", "w1", None, "a", "grid", "{}", None).unwrap();
        create(&conn, "b", "w1", None, "b", "grid", "{}", None).unwrap();
        create(&conn, "c", "w1", Some("a"), "c", "grid", "{}", None).unwrap();
        let pa: i64 = conn.query_row("SELECT position FROM views WHERE id='a'", [], |r| r.get(0)).unwrap();
        let pb: i64 = conn.query_row("SELECT position FROM views WHERE id='b'", [], |r| r.get(0)).unwrap();
        let pc: i64 = conn.query_row("SELECT position FROM views WHERE id='c'", [], |r| r.get(0)).unwrap();
        assert_eq!((pa, pb, pc), (0, 1, 0));
    }

    #[test]
    fn subtree_soft_delete_restore_and_purge() {
        let conn = setup();
        seed_default_fixture(&conn);
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();

        soft_delete(&conn, "c1").unwrap();
        for (id, trashed) in [("c1", 1), ("d1", 1), ("r1", 0)] {
            let t: i64 = conn.query_row("SELECT is_trash FROM views WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
            assert_eq!(t, trashed, "{id} trash state");
        }
        let del: Option<i64> = conn.query_row("SELECT deleted_at FROM views WHERE id='c1'", [], |r| r.get(0)).unwrap();
        assert!(del.is_some());

        restore(&conn, "c1").unwrap();
        let t: i64 = conn.query_row("SELECT is_trash FROM views WHERE id='d1'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, 0);

        purge(&conn, "c1").unwrap();
        // c1 被彻底删除；d1 在 restore 后已回到树里，不陪葬（改挂到 c1 的父级 r1）
        let c1: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(c1, 0, "c1 purged");
        let (d1, d1_parent): (i64, Option<String>) = conn
            .query_row("SELECT COUNT(*), MAX(parent_id) FROM views WHERE id = 'd1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(d1, 1, "restored descendant survives parent purge");
        assert_eq!(d1_parent.as_deref(), Some("r1"));
        let r1: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id='r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(r1, 1);
    }

    #[test]
    fn purge_keeps_child_restored_from_trash() {
        // 报告场景：删父页 → 在回收站单独恢复子页 → 彻底删除父页，子页及其文档必须存活
        let conn = setup();
        seed_default_fixture(&conn);
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES ('d1', '{\"type\":\"doc\"}', 1)",
            [],
        )
        .unwrap();

        soft_delete(&conn, "c1").unwrap();
        restore(&conn, "d1").unwrap();
        purge(&conn, "c1").unwrap();

        let doc: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents WHERE view_id = 'd1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(doc, 1, "restored child document must survive");
        let parent: Option<String> = conn
            .query_row("SELECT parent_id FROM views WHERE id = 'd1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(parent.as_deref(), Some("r1"), "child re-attached to grandparent");
    }

    #[test]
    fn purge_trash_reparents_restored_children_instead_of_leaving_dangling_parent() {
        let conn = setup();
        seed_default_fixture(&conn);
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();

        soft_delete(&conn, "c1").unwrap();
        restore(&conn, "d1").unwrap();
        purge_trash(&conn, "w1").unwrap();

        let (survives, parent): (i64, Option<String>) = conn
            .query_row("SELECT COUNT(*), MAX(parent_id) FROM views WHERE id = 'd1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(survives, 1, "restored child survives empty-trash");
        assert_eq!(parent, None, "no dangling parent_id after empty-trash");
    }

    #[test]
    fn purge_expired_trash_counts_and_respects_null_deleted_at() {
        let conn = setup();
        seed_default_fixture(&conn);
        let old = now_ms() - 40 * 24 * 3600 * 1000;
        conn.execute("UPDATE views SET is_trash = 1, deleted_at = ?1 WHERE id = 'r2'", params![old]).unwrap();
        conn.execute("UPDATE views SET is_trash = 1 WHERE id = 'r3'", []).unwrap(); // deleted_at 仍为 NULL

        let n = purge_expired_trash(&conn, "w1", now_ms() - 30 * 24 * 3600 * 1000).unwrap();
        assert_eq!(n, 1);
        let r2: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id='r2'", [], |r| r.get(0)).unwrap();
        assert_eq!(r2, 0);
        let r3: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id='r3'", [], |r| r.get(0)).unwrap();
        assert_eq!(r3, 1);
    }

    // ---------- 多视图（迁移 007：views.source_id） ----------

    /// 在宿主表上建一个派生视图
    fn derive(conn: &Connection, id: &str, host: &str, name: &str, layout: &str) -> ViewRow {
        create(conn, id, "w1", None, name, layout, "{}", Some(host)).unwrap()
    }

    fn ids(rows: &[ViewRow]) -> Vec<String> {
        rows.iter().map(|v| v.id.clone()).collect()
    }

    #[test]
    fn derived_views_hide_from_tree_trash_and_recent() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");
        conn.execute("UPDATE views SET visited_at = 5 WHERE id = 'd1'", []).unwrap();

        // 活跃态：派生视图既不在树里，也不因 visited_at 出现在最近
        assert_eq!(ids(&list_by_workspace(&conn, "w1").unwrap()), vec!["g1"]);
        assert!(list_recent(&conn, "w1", 10).unwrap().is_empty(), "派生视图不进最近列表");

        // 回收站：派生视图随宿主一起软删，但不单独占一行
        soft_delete(&conn, "g1").unwrap();
        assert_eq!(ids(&list_trash(&conn, "w1").unwrap()), vec!["g1"]);
    }

    #[test]
    fn list_for_source_returns_host_first_then_derived_by_position() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d2", "g1", "日历", "calendar");
        derive(&conn, "d1", "g1", "看板", "board");
        assert_eq!(ids(&list_for_source(&conn, "g1").unwrap()), vec!["g1", "d2", "d1"]);

        // 宿主自身的派生视图不会漏，别的表也串不进来
        create(&conn, "g2", "w1", None, "另一张表", "grid", "{}", None).unwrap();
        assert_eq!(ids(&list_for_source(&conn, "g2").unwrap()), vec!["g2"]);
    }

    #[test]
    fn create_derived_view_scopes_position_and_rejects_bad_host() {
        let conn = setup();
        // 宿主的树内 position 已占用 0/1，派生视图的 position 另起一套从 0 开始
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        create(&conn, "g2", "w1", None, "表2", "grid", "{}", None).unwrap();
        assert_eq!(derive(&conn, "d1", "g1", "看板", "board").position, 0);
        assert_eq!(derive(&conn, "d2", "g1", "日历", "calendar").position, 1);
        let g1_pos: i64 = conn.query_row("SELECT position FROM views WHERE id='g1'", [], |r| r.get(0)).unwrap();
        assert_eq!(g1_pos, 0, "派生视图不抢宿主的树内排序位");

        // 派生视图不进树：parent_id 强制 NULL，哪怕调用方传了父节点
        let d = create(&conn, "d3", "w1", Some("g2"), "x", "grid", "{}", Some("g1")).unwrap();
        assert_eq!(d.parent_id, None);
        assert_eq!(d.source_id.as_deref(), Some("g1"));

        // 宿主不存在 → 报错
        let err = create(&conn, "d4", "w1", None, "x", "board", "{}", Some("ghost")).unwrap_err();
        assert!(err.contains("database view not found"), "{err}");
        // 派生视图不能再被派生（否则数据归属要递归解析）
        let err = create(&conn, "d5", "w1", None, "x", "board", "{}", Some("d1")).unwrap_err();
        assert!(err.contains("database view not found"), "{err}");
        // document 布局的派生视图没有意义（内容挂在 documents 上）
        let err = create(&conn, "d6", "w1", None, "x", "document", "{}", Some("g1")).unwrap_err();
        assert!(err.contains("document layout"), "{err}");
    }

    #[test]
    fn soft_delete_and_restore_cover_derived_views() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");

        soft_delete(&conn, "g1").unwrap();
        let (t, del): (i64, Option<i64>) = conn
            .query_row("SELECT is_trash, deleted_at FROM views WHERE id='d1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((t, del.is_some()), (1, true), "派生视图随宿主进回收站");

        restore(&conn, "g1").unwrap();
        let (t, del): (i64, Option<i64>) = conn
            .query_row("SELECT is_trash, deleted_at FROM views WHERE id='d1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((t, del.is_some()), (0, false), "恢复后派生视图回来且 deleted_at 清空");
    }

    #[test]
    fn purge_host_cascades_to_derived_views() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");
        purge(&conn, "g1").unwrap(); // views.source_id 的 FK ON DELETE CASCADE
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn move_renumber_ignores_derived_views() {
        let conn = setup();
        seed_default_fixture(&conn); // r1/r2/r3 根级 0..2
        derive(&conn, "d1", "r1", "看板", "board"); // parent_id 同为 NULL
        move_view(&conn, "r3", Some("r1"), 0).unwrap();
        let l = layout(&conn);
        assert_eq!(l["r3"], (Some("r1".into()), 0));
        assert_eq!(l["r1"], (None, 0));
        assert_eq!(l["r2"], (None, 1));
        // 派生视图没被当成根级兄弟参与重排：仍是 NULL 父级、position 独立
        assert_eq!(l["d1"], (None, 0));
    }

    #[test]
    fn duplicate_copies_subtree_with_content_and_properties() {
        let conn = setup();
        seed_default_fixture(&conn); // r1(0)/r2(1)/r3(2)，c1..c3 挂在 r1 下
        conn.execute("UPDATE views SET is_favorite = 1, tags = '[\"甲\"]' WHERE id = 'r1'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO documents(view_id, content, updated_at) VALUES ('r1', '{\"text\":\"正文\"}', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO page_properties(view_id, key, value, field_type, position)
             VALUES ('r1', '状态', 'done', 'text', 0)",
            [],
        )
        .unwrap();

        let (view, docs) = duplicate(&conn, "r1", "r1copy", "r1 副本").unwrap();

        assert_eq!(view.name, "r1 副本");
        assert_eq!(view.parent_id, None);
        assert_eq!(view.position, 3, "副本排在同级末尾");
        assert_eq!(view.is_favorite, 0, "收藏不继承");
        let tags: String = conn
            .query_row("SELECT tags FROM views WHERE id = 'r1copy'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, "[\"甲\"]", "标签继承");

        // 整棵子树：3 个子节点，父级指向副本根，名称与相对顺序保持
        let l = layout(&conn);
        assert_eq!(l["r1copy_1"], (Some("r1copy".into()), 0));
        assert_eq!(l["r1copy_2"], (Some("r1copy".into()), 1));
        assert_eq!(l["r1copy_3"], (Some("r1copy".into()), 2));
        let child_name: String = conn
            .query_row("SELECT name FROM views WHERE id = 'r1copy_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(child_name, "c1");

        // 正文：返回值供调用方重建反链，库里与 FTS 同步（触发器取副本名作 title）
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].view_id, "r1copy");
        assert_eq!(docs[0].content, "{\"text\":\"正文\"}");
        let fts_title: String = conn
            .query_row("SELECT title FROM documents_fts WHERE view_id = 'r1copy'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts_title, "r1 副本");

        let pp: i64 = conn
            .query_row("SELECT COUNT(*) FROM page_properties WHERE view_id = 'r1copy'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pp, 1);

        // 源节点与其子树未被改动
        assert_eq!(layout(&conn)["r1"], (None, 0));
        let src_children: i64 = conn
            .query_row("SELECT COUNT(*) FROM views WHERE parent_id = 'r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src_children, 3);
    }

    #[test]
    fn duplicate_copies_database_fields_rows_cells_and_row_documents() {
        let conn = setup();
        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        conn.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES ('f1','g1','名称','text','{\"kind\":\"none\"}',180,0,0),
                    ('f2','g1','创建时间','created_at','{\"kind\":\"none\"}',180,0,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at)
             VALUES ('r1','g1',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','\"甲\"')",
            [],
        )
        .unwrap();
        // 行详情文档：数据库页面的子节点（extra.row_detail 使其不进页面树，但仍在 parent_id 链上）
        create(&conn, "rd1", "w1", Some("g1"), "行详情", "document", "{\"row_detail\":true}", None).unwrap();
        conn.execute("UPDATE database_rows SET document_id = 'rd1' WHERE id = 'r1'", [])
            .unwrap();
        conn.execute("UPDATE documents SET content = '{\"text\":\"行正文\"}' WHERE view_id = 'rd1'", [])
            .unwrap();

        duplicate(&conn, "g1", "g1copy", "表 副本").unwrap();

        let field_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_fields WHERE database_view_id = 'g1copy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(field_count, 2);
        let copied_type: String = conn
            .query_row("SELECT field_type FROM database_fields WHERE id = 'g1copy_f0'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(copied_type, "text");

        // 行：document_id 映射到复制出来的行详情文档（子树里唯一的子节点）
        let (row_id, row_doc): (String, Option<String>) = conn
            .query_row(
                "SELECT id, document_id FROM database_rows WHERE database_view_id = 'g1copy'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let copied_rd = row_doc.expect("行详情文档应被映射到副本");
        assert_eq!(copied_rd, "g1copy_1");
        let rd_parent: Option<String> = conn
            .query_row("SELECT parent_id FROM views WHERE id = ?1", params![copied_rd], |r| r.get(0))
            .unwrap();
        assert_eq!(rd_parent.as_deref(), Some("g1copy"));
        let rd_content: String = conn
            .query_row("SELECT content FROM documents WHERE view_id = ?1", params![copied_rd], |r| r.get(0))
            .unwrap();
        assert_eq!(rd_content, "{\"text\":\"行正文\"}");

        // 单元格：普通字段值搬运，时间戳字段由触发器写成新时间
        let copied_value: String = conn
            .query_row(
                "SELECT value FROM database_cells WHERE row_id = ?1 AND field_id = 'g1copy_f0'",
                params![row_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copied_value, "\"甲\"");
        let ts_value: String = conn
            .query_row(
                "SELECT value FROM database_cells WHERE row_id = ?1 AND field_id = 'g1copy_f1'",
                params![row_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ts_value.contains('T'), "created_at 单元格应为新时间: {ts_value}");

        // 源表不受影响：文本单元格 + 插行触发器写入的 created_at 单元格
        let src_cells: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_cells WHERE row_id = 'r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src_cells, 2);
    }

    #[test]
    fn duplicate_missing_source_and_derived_view_are_rejected() {
        let conn = setup();
        let err = duplicate(&conn, "ghost", "newcopy", "副本").unwrap_err();
        assert!(err.contains("view not found"), "{err}");

        create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
        derive(&conn, "d1", "g1", "看板", "board");
        let err = duplicate(&conn, "d1", "dcopy", "看板 副本").unwrap_err();
        assert!(err.contains("derived view"), "{err}");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM views WHERE id = 'dcopy'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "失败的复制不留下半成品");
    }
}
