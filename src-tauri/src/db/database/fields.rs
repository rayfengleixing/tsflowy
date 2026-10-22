// database_fields 领域函数（从 database/mod.rs 原样搬入，逻辑未改）。
// 跨域共用的 next_position / default_options_json 留在父模块，这里用 super:: 取。
use rusqlite::{params, Connection, OptionalExtension};

use super::super::models::{DatabaseFieldRow, RelationPairOut};
use super::super::views::data_view_id;
use super::super::{dberr, now_ms};
use super::{default_options_json, next_position};

fn field_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseFieldRow> {
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
}

// ---------- 字段 ----------

pub fn list_fields(conn: &Connection, view_id: &str) -> Result<Vec<DatabaseFieldRow>, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let mut stmt = conn
        .prepare(
            "SELECT id, database_view_id, name, field_type, options, width, is_hidden, position
             FROM database_fields WHERE database_view_id = ?1 ORDER BY position ASC",
        )
        .map_err(dberr("list fields"))?;
    let rows = stmt
        .query_map(params![view_id], field_from_row)
        .map_err(dberr("list fields"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("list fields"))?;
    Ok(rows)
}

/// id 由前端 newId() 生成后传入；name 缺省用类型名（与旧 JS 一致）。
pub fn create_field(
    conn: &Connection,
    view_id: &str,
    id: &str,
    field_type: &str,
    name: Option<&str>,
) -> Result<DatabaseFieldRow, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let name = name.unwrap_or(field_type);
    let options = default_options_json(field_type);
    let position = next_position(conn, "database_fields", view_id)?;
    conn.execute(
        "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
         VALUES (?1, ?2, ?3, ?4, ?5, 180, 0, ?6)",
        params![id, view_id, name, field_type, options, position],
    )
    .map_err(dberr("create field"))?;
    Ok(DatabaseFieldRow {
        id: id.to_string(),
        database_view_id: view_id.to_string(),
        name: name.to_string(),
        field_type: field_type.to_string(),
        options,
        width: 180,
        is_hidden: 0,
        position,
    })
}

pub fn rename_field(conn: &Connection, field_id: &str, name: &str) -> Result<(), String> {
    // 归属校验：id 不存在（错视图/已删除的悬空引用）时报错，而不是静默 no-op——
    // 否则前端还会带着旧 name 乐观更新，公式改名连锁也整条走空
    let affected = conn
        .execute(
            "UPDATE database_fields SET name = ?1 WHERE id = ?2",
            params![name, field_id],
        )
        .map_err(dberr("rename field"))?;
    if affected == 0 {
        return Err(format!("重命名字段失败：字段 {field_id} 不存在"));
    }
    Ok(())
}

pub fn delete_field(conn: &Connection, field_id: &str) -> Result<(), String> {
    // 关联列删掉时，它自动配出去、且对端没改过配置的反向列一并删掉：
    // 反向列的来源字段就是这条关联列，留着只会变成一排恒为空的僵尸列。
    let paired = untouched_paired_reverse(conn, field_id)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("delete field"))?;
    if let Some(pid) = paired {
        tx.execute("DELETE FROM database_fields WHERE id = ?1", params![pid])
            .map_err(dberr("delete field (paired reverse)"))?; // cells 同样 FK 级联
    }
    tx.execute(
        "DELETE FROM database_fields WHERE id = ?1",
        params![field_id],
    )
    .map_err(dberr("delete field"))?; // cells 经 FK 级联
    tx.commit().map_err(dberr("delete field (commit)"))?;
    Ok(())
}

/// 这条字段自动配对出去、且对端没改过配置的反向列 id；没有则 None。
/// 「没改过」只看到 options 层面：对端一旦重指了来源表/来源字段就不再是我们的配对。
fn untouched_paired_reverse(conn: &Connection, field_id: &str) -> Result<Option<String>, String> {
    let own: Option<(String, String)> = conn
        .query_row(
            "SELECT database_view_id, options FROM database_fields WHERE id = ?1",
            params![field_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr("delete field (read paired)"))?;
    let Some((own_view_id, options)) = own else {
        return Ok(None);
    };
    let Some(paired_id) = paired_field_id(&options) else {
        return Ok(None);
    };
    let source_host = data_view_id(conn, &own_view_id)?;
    let back: Option<String> = conn
        .query_row(
            "SELECT options FROM database_fields WHERE id = ?1",
            params![&paired_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr("delete field (read reverse)"))?;
    let Some(reverse_options) = back else {
        return Ok(None);
    };
    Ok(untouched_reverse_options(&reverse_options, &source_host, field_id).then_some(paired_id))
}

/// 关联列 options 里的 paired_field_id（缺省/空串都算没配对）
fn paired_field_id(options: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(options)
        .ok()?
        .get("paired_field_id")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 反向关系列的 options 是否仍然「只回指 source_view_id 的 source_field_id」——
/// 也就是建出来之后没人动过配置。配对/解配对只敢碰这种列。
fn untouched_reverse_options(options: &str, source_view_id: &str, source_field_id: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(options) else {
        return false;
    };
    let read = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    read("kind").as_deref() == Some("reverse_relation")
        && read("source_view_id").as_deref() == Some(source_view_id)
        && read("source_field_id").as_deref() == Some(source_field_id)
}

/// 关联列选定/改指目标表：在对端表建一条反向关系列，并把 paired_field_id 写回本列。
/// 两张表的写入必须在一个事务里——只成功一半就留下「本列指向对端、对端没有回指列」的半配对。
/// 已经配对且对端没改过配置时复用那条列：反复打开字段设置不该堆出一排同义列。
/// 换目标表时旧的反向列保持原样（它可能已被改名、被公式引用），只把配对指针挪到新列上。
pub fn pair_relation_field(
    conn: &Connection,
    field_id: &str,
    target_view_id: &str,
    reverse_id: &str,
    reverse_name: &str,
) -> Result<RelationPairOut, String> {
    let (own_view_id, field_type, options): (String, String, String) = conn
        .query_row(
            "SELECT database_view_id, field_type, options FROM database_fields WHERE id = ?1",
            params![field_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(dberr("pair relation (read field)"))?
        .ok_or_else(|| format!("配对反向列失败：字段 {field_id} 不存在"))?;
    if field_type != "relation" {
        return Err(format!("字段 {field_id} 不是关联列，不能配对反向列"));
    }
    if target_view_id.trim().is_empty() {
        return Err("关联列还没有选择目标表，不能配对反向列".to_string());
    }
    let source_host = data_view_id(conn, &own_view_id)?;
    let target_host = data_view_id(conn, target_view_id)?;
    // data_view_id 对不存在的视图原样返回，所以目标表是否真存在要单独确认一次
    let target_exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM views WHERE id = ?1",
            params![&target_host],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr("pair relation (check target)"))?;
    if target_exists.is_none() {
        return Err(format!("配对反向列失败：目标表 {target_view_id} 不存在"));
    }

    let existing_paired = paired_field_id(&options);
    // 旧的配对列三种去处：仍在本次目标表里、且没人改过配置 → 复用；
    // 是我们建出来但已经换到别的表了 → 删掉（指向的关联列不再落在它头上，留着只会是一排恒空僵尸列）；
    // 配置被改过 → 原样留着（可能已被改名或被公式引用，动它等于毁用户的数据）。
    let mut reuse_reverse_id = String::new();
    let mut stale_reverse_id: Option<String> = None;
    if let Some(paired_id) = existing_paired {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT database_view_id, options FROM database_fields WHERE id = ?1",
                params![&paired_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(dberr("pair relation (read paired)"))?;
        if let Some((vid, opts)) = existing {
            if untouched_reverse_options(&opts, &source_host, field_id) {
                if vid == target_host {
                    reuse_reverse_id = paired_id;
                } else {
                    stale_reverse_id = Some(paired_id);
                }
            }
        }
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("pair relation"))?;
    if let Some(sid) = &stale_reverse_id {
        tx.execute("DELETE FROM database_fields WHERE id = ?1", params![sid])
            .map_err(dberr("pair relation (drop stale reverse)"))?; // cells 经 FK 级联
    }
    let reverse_field_id = if !reuse_reverse_id.is_empty() {
        reuse_reverse_id
    } else {
        let reverse_options = serde_json::json!({
            "kind": "reverse_relation",
            "source_view_id": source_host,
            "source_field_id": field_id,
        })
        .to_string();
        let position = next_position(&tx, "database_fields", &target_host)?;
        tx.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES (?1, ?2, ?3, 'reverse_relation', ?4, 180, 0, ?5)",
            params![reverse_id, target_host, reverse_name, reverse_options, position],
        )
        .map_err(dberr("pair relation (create reverse)"))?;
        reverse_id.to_string()
    };
    let relation_options = serde_json::json!({
        "kind": "relation",
        "target_view_id": target_host,
        "paired_field_id": reverse_field_id,
    })
    .to_string();
    tx.execute(
        "UPDATE database_fields SET options = ?1 WHERE id = ?2",
        params![relation_options, field_id],
    )
    .map_err(dberr("pair relation (write options)"))?;
    tx.commit().map_err(dberr("pair relation (commit)"))?;

    let relation_field = conn
        .query_row(
            "SELECT id, database_view_id, name, field_type, options, width, is_hidden, position
             FROM database_fields WHERE id = ?1",
            params![field_id],
            field_from_row,
        )
        .map_err(dberr("pair relation (reload field)"))?;
    Ok(RelationPairOut {
        relation_field,
        reverse_field_id,
    })
}

pub fn set_field_width(conn: &Connection, field_id: &str, width: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE database_fields SET width = ?1 WHERE id = ?2",
        params![width, field_id],
    )
    .map_err(dberr("set field width"))?;
    Ok(())
}

pub fn set_field_hidden(conn: &Connection, field_id: &str, hidden: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE database_fields SET is_hidden = ?1 WHERE id = ?2",
        params![i64::from(hidden), field_id],
    )
    .map_err(dberr("set field hidden"))?;
    Ok(())
}

/// options 为已序列化 JSON 字符串（JS 侧 JSON.stringify 产出）。
pub fn update_field_options(
    conn: &Connection,
    field_id: &str,
    options: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE database_fields SET options = ?1 WHERE id = ?2",
        params![options, field_id],
    )
    .map_err(dberr("update field options"))?;
    Ok(())
}

/// 整列重排：ordered_ids 为最终顺序（position 0..n-1）。单事务避免中间态。
pub fn reorder_fields(
    conn: &Connection,
    view_id: &str,
    ordered_ids: &[&str],
) -> Result<(), String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("reorder fields"))?;
    for (i, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE database_fields SET position = ?1 WHERE id = ?2 AND database_view_id = ?3",
            params![i as i64, id, view_id],
        )
        .map_err(dberr("reorder fields"))?;
    }
    tx.commit().map_err(dberr("reorder fields (commit)"))?;
    Ok(())
}

/// 留存一列改类型前的取值上限：再大就不只是「误操作反悔」而是整表归档了，
/// 那份 JSON 会长期占着库文件（同步时整库算指纹，也跟着变慢）
const FIELD_SNAPSHOT_MAX_CELLS: usize = 50_000;

/// 改字段类型：重置默认 options，并清空该字段所有单元格值（类型不兼容的数据不可保留）。
/// 同类型重选是 no-op：UI 已对当前类型禁用，这里兜底防止误清整列数据。
/// 两处 UPDATE 必须同事务：中途失败时不允许出现「类型已换、旧值还挂着」的半程状态。
///
/// 清空前把该列的非空取值与字段定义存进 database_field_snapshots（每个字段只留最近一份），
/// 前端据此给「撤销」入口 —— 否则误选一次类型只能靠恢复整库备份，代价是丢掉这期间的所有编辑。
/// 返回留存的单元格数（0 表示这列本来就空，没有可回退的东西）。
pub fn change_field_type(conn: &Connection, field_id: &str, new_type: &str) -> Result<i64, String> {
    let current: Option<(String, String)> = conn
        .query_row(
            "SELECT field_type, options FROM database_fields WHERE id = ?1",
            params![field_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr("change field type (read current)"))?;
    let Some((from_type, from_options)) = current else {
        return Ok(0);
    };
    if from_type == new_type {
        return Ok(0);
    }
    let cells: Vec<(String, String)> = conn
        .prepare(
            "SELECT row_id, value FROM database_cells
             WHERE field_id = ?1 AND value <> 'null' ORDER BY row_id",
        )
        .map_err(dberr("change field type (read cells)"))?
        .query_map(params![field_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(dberr("change field type (read cells)"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("change field type (read cells)"))?;

    let options = default_options_json(new_type);
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("change field type"))?;
    let preserved = if cells.is_empty() || cells.len() > FIELD_SNAPSHOT_MAX_CELLS {
        0
    } else {
        // 覆盖式留存：字段级唯一键，历史只留最近一次改类型
        tx.execute(
            "INSERT INTO database_field_snapshots(field_id, from_type, from_options, values_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(field_id) DO UPDATE SET
               from_type = excluded.from_type,
               from_options = excluded.from_options,
               values_json = excluded.values_json,
               created_at = excluded.created_at",
            params![
                field_id,
                from_type,
                from_options,
                serde_json::to_string(&cells)
                    .map_err(|e| format!("序列化列值留存失败：{e}"))?,
                now_ms()
            ],
        )
        .map_err(dberr("change field type (snapshot)"))?;
        // 报给前端的是「留了几个值」，不是那条 INSERT 影响的行数（它恒为 1）
        cells.len() as i64
    };
    tx.execute(
        "UPDATE database_fields SET field_type = ?1, options = ?2 WHERE id = ?3",
        params![new_type, options, field_id],
    )
    .map_err(dberr("change field type"))?;
    tx.execute(
        "UPDATE database_cells SET value = 'null' WHERE field_id = ?1",
        params![field_id],
    )
    .map_err(dberr("change field type (clear cells)"))?;
    tx.commit().map_err(dberr("change field type (commit)"))?;
    Ok(preserved)
}

/// 把留存的那一列取值还原回去：字段定义（类型 + options）一并退回改类型前那个时刻。
/// 还原即消费：快照删掉，避免「撤销撤销」把同一份旧值反复盖回来。
/// 期间被删掉的行自动跳过（单元格的外键指向行），其余行按原值写回。
pub fn restore_field_values(conn: &Connection, field_id: &str) -> Result<i64, String> {
    let snap: Option<(String, String, String)> = conn
        .query_row(
            "SELECT from_type, from_options, values_json FROM database_field_snapshots WHERE field_id = ?1",
            params![field_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(dberr("restore field values (read snapshot)"))?;
    let Some((from_type, from_options, values_json)) = snap else {
        return Err(format!("字段 {field_id} 没有可还原的列值留存"));
    };
    let cells: Vec<(String, String)> =
        serde_json::from_str(&values_json).map_err(|e| format!("解析列值留存失败：{e}"))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("restore field values"))?;
    tx.execute(
        "UPDATE database_fields SET field_type = ?1, options = ?2 WHERE id = ?3",
        params![from_type, from_options, field_id],
    )
    .map_err(dberr("restore field values (field)"))?;
    let mut restored = 0i64;
    for (row_id, value) in &cells {
        // WHERE EXISTS：留存之后行可能被删掉，直接插会撞 database_cells.row_id 的外键
        restored += tx
            .execute(
                "INSERT INTO database_cells(row_id, field_id, value)
                 SELECT ?1, ?2, ?3
                 WHERE EXISTS (SELECT 1 FROM database_rows WHERE id = ?1)
                 ON CONFLICT(row_id, field_id) DO UPDATE SET value = excluded.value",
                params![row_id, field_id, value],
            )
            .map_err(dberr("restore field values (cell)"))? as i64;
    }
    tx.execute(
        "DELETE FROM database_field_snapshots WHERE field_id = ?1",
        params![field_id],
    )
    .map_err(dberr("restore field values (drop snapshot)"))?;
    tx.commit()
        .map_err(dberr("restore field values (commit)"))?;
    Ok(restored)
}
