use rusqlite::{params, Connection, OptionalExtension};

use super::super::models::{DatabaseFieldRow, DatabaseRowRow, DocRowOut, ViewRow};
use super::super::{dberr, now_ms};

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

pub(super) fn query_views(
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
const VISIBLE_IN_TREE: &str =
    " AND json_extract(extra, '$.row_detail') IS NOT 1 AND source_id IS NULL";

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

pub fn list_recent(
    conn: &Connection,
    workspace_id: &str,
    limit: i64,
) -> Result<Vec<ViewRow>, String> {
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
    conn.execute(
        "UPDATE views SET visited_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )
    .map_err(dberr("touch visited"))?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<ViewRow>, String> {
    conn.query_row(
        "SELECT * FROM views WHERE id = ?1",
        params![id],
        row_to_view,
    )
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
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("duplicate view"))?;

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
            .query_row(
                "SELECT content FROM documents WHERE view_id = ?1",
                params![old_id],
                |r| r.get(0),
            )
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
            let new_doc = r.document_id.as_ref().and_then(|d| {
                pairs
                    .iter()
                    .find(|(old, _)| old == d)
                    .map(|(_, new)| new.clone())
            });
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
