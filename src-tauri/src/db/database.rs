use rusqlite::{params, Connection, OptionalExtension};

use super::models::{
    CellLoadRow, CellSetIn, CsvFieldIn, CsvRowIn, DatabaseFieldRow, DatabaseRowRow,
    RelationPairOut, TrashRowOut,
};
use super::views::data_view_id;
use super::views::trash::{purge_within, with_recursive_subtree};
use super::{dberr, now_ms};

// 数据库三表（database_fields / database_rows / database_cells）领域函数，
// 行形状与 tauri-plugin-sql 时代 select 结果逐字节一致。
// 002 迁移的两个触发器继续生效：
// - trg_cells_row_inserted：INSERT 行时为已有 created_at/last_edited_at 字段自动补单元格
// - trg_cells_value_changed：单元格值 UPDATE 且变化时刷新行 updated_at + last_edited_at
//
// 多视图（迁移 007）：一张表的数据只挂在宿主视图上，派生视图是纯显示配置。
// 因此所有以 view_id 为入参的函数先过一遍 data_view_id 折算成宿主 id 再执行；
// 返回行里的 database_view_id 是宿主 id（前端不读该列做等值比较，仅类型保留）。

/// 由 002 迁移的两个触发器维护单元格值的字段：插行写 created_at、改值刷 last_edited_at。
/// 复制视图时这几类的源单元格不搬（见 views::crud），前端也据此判定「不能在 UI 改」。
/// 取值与 contracts/field_type_contract.json 的 triggerManagedTimestampTypes 由契约测试核对。
pub const TRIGGER_MANAGED_TIMESTAMPS: [&str; 2] = ["created_at", "last_edited_at"];

/// 镜像前端 database-values.ts defaultOptionsFor：新字段/改类型写入的默认 options JSON。
/// 键序由 serde_json 字典序决定，消费方 parseFieldOptions 按键名读取，无顺序依赖。
pub fn default_options_json(field_type: &str) -> String {
    match field_type {
        // status（状态）与单选同值形态：单元格存选项 id，阶段信息在选项里由前端标注
        "single_select" | "multi_select" | "status" => {
            serde_json::json!({ "kind": "select", "options": [] }).to_string()
        }
        "number" => serde_json::json!({
            "kind": "number", "format": "decimal", "precision": 2, "currency": "CNY"
        })
        .to_string(),
        // 货币：与 number 同一 options 形态，前端展示时强制 format=currency
        "currency" => serde_json::json!({
            "kind": "number", "format": "currency", "precision": 2, "currency": "CNY"
        })
        .to_string(),
        // 评分：满星数可配（默认 5）
        "rating" => serde_json::json!({ "kind": "rating", "max": 5 }).to_string(),
        "date" => serde_json::json!({ "kind": "date", "include_time": false }).to_string(),
        // 关联：目标库（宿主数据库视图 id）由前端在字段设置里选择，先给空占位
        "relation" => serde_json::json!({ "kind": "relation", "target_view_id": "" }).to_string(),
        // 汇总：对关联行里的目标字段做聚合；三项配置都由前端在字段设置里选择
        "rollup" => serde_json::json!({
            "kind": "rollup", "relation_field_id": "", "target_field_id": "", "fn": "count"
        })
        .to_string(),
        // 反向关系：读目标库中某个 relation 字段指向本表时，展示回指本行的来源行（前端配置）
        "reverse_relation" => serde_json::json!({
            "kind": "reverse_relation", "source_view_id": "", "source_field_id": ""
        })
        .to_string(),
        // 附件：单元格存 [{name, path}] 数组，文件落 assets/；无需额外配置
        "attachment" => serde_json::json!({ "kind": "none" }).to_string(),
        _ => serde_json::json!({ "kind": "none" }).to_string(),
    }
}

/// 表名只来自调用方写死的两处字面量，不接收用户输入。
/// 行表要排掉回收站里的行：新行接在「表里可见的行」末尾，deleted 行占的旧号由恢复时重排。
fn next_position(conn: &Connection, table: &str, view_id: &str) -> Result<i64, String> {
    debug_assert!(matches!(table, "database_fields" | "database_rows"));
    let live = if table == "database_rows" {
        " AND is_trash = 0"
    } else {
        ""
    };
    conn.query_row(
        &format!(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM {table} WHERE database_view_id = ?1{live}"
        ),
        params![view_id],
        |r| r.get(0),
    )
    .map_err(dberr("next position"))
}

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

// ---------- 单元格 ----------

/// 全量读取某视图所有单元格（扁平行；JS 侧组装成 rowId → fieldId → 值并 JSON.parse）。
pub fn load_cells(conn: &Connection, view_id: &str) -> Result<Vec<CellLoadRow>, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let mut stmt = conn
        .prepare(
            "SELECT c.row_id, c.field_id, c.value
             FROM database_cells c
             JOIN database_rows r ON r.id = c.row_id
             WHERE r.database_view_id = ?1 AND r.is_trash = 0",
        )
        .map_err(dberr("load cells"))?;
    let rows = stmt
        .query_map(params![view_id], |r| {
            Ok(CellLoadRow {
                row_id: r.get(0)?,
                field_id: r.get(1)?,
                value: r.get(2)?,
            })
        })
        .map_err(dberr("load cells"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr("load cells"))?;
    Ok(rows)
}

/// upsert 单元格。value 为已序列化 JSON 字符串（JS 侧 serializeValue 产出，与旧库字节一致）。
pub fn set_cell(
    conn: &Connection,
    row_id: &str,
    field_id: &str,
    value: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO database_cells(row_id, field_id, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(row_id, field_id) DO UPDATE SET value = ?3",
        params![row_id, field_id, value],
    )
    .map_err(dberr("set cell"))?;
    Ok(())
}

/// 批量 upsert 单元格：一个事务内落全部写入，替代逐格 IPC（TSV 粘贴路径）。
/// 与 set_cell 同语义（只 upsert，不校验 row/field 归属：调用方给的 id 来自已加载数据）。
pub fn set_cells_many(conn: &Connection, updates: &[CellSetIn]) -> Result<usize, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(dberr("set cells many"))?;
    for u in updates {
        tx.execute(
            "INSERT INTO database_cells(row_id, field_id, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(row_id, field_id) DO UPDATE SET value = ?3",
            params![u.row_id, u.field_id, u.value],
        )
        .map_err(dberr("set cells many"))?;
    }
    tx.commit().map_err(dberr("set cells many (commit)"))?;
    Ok(updates.len())
}

/// 批量追加行：一个事务内按入参顺序建行并返回（position 连续，同 create_row 语义）。
pub fn create_rows(
    conn: &Connection,
    view_id: &str,
    ids: &[String],
) -> Result<Vec<DatabaseRowRow>, String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let tx = conn.unchecked_transaction().map_err(dberr("create rows"))?;
    let start = next_position(conn, "database_rows", view_id)?;
    let mut out = Vec::with_capacity(ids.len());
    for (offset, id) in ids.iter().enumerate() {
        let position = start + offset as i64;
        let t = now_ms();
        tx.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, view_id, position, t],
        )
        .map_err(dberr("create rows"))?;
        out.push(DatabaseRowRow {
            id: id.clone(),
            database_view_id: view_id.to_string(),
            position,
            document_id: None,
            parent_id: None,
            created_at: t,
            updated_at: t,
        });
    }
    tx.commit().map_err(dberr("create rows (commit)"))?;
    Ok(out)
}

/// CSV 导入单命令：一个事务内落全部字段/行/单元格（替代旧 JS 侧 N+1 IPC 循环）。
/// 字段默认 options 在 Rust 侧生成；position 按入参顺序 0..n-1。
pub fn csv_import(
    conn: &Connection,
    view_id: &str,
    fields: &[CsvFieldIn],
    rows: &[CsvRowIn],
) -> Result<(usize, usize, usize), String> {
    let host = data_view_id(conn, view_id)?;
    let view_id = host.as_str();
    let tx = conn.unchecked_transaction().map_err(dberr("csv import"))?;
    for (i, f) in fields.iter().enumerate() {
        let options = f
            .options
            .clone()
            .unwrap_or_else(|| default_options_json(&f.field_type));
        tx.execute(
            "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
             VALUES (?1, ?2, ?3, ?4, ?5, 180, 0, ?6)",
            params![f.id, view_id, f.name, f.field_type, options, i as i64],
        )
        .map_err(dberr("csv import"))?;
    }
    let mut cell_count = 0usize;
    for (i, r) in rows.iter().enumerate() {
        let t = now_ms();
        tx.execute(
            "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![r.id, view_id, i as i64, t],
        )
        .map_err(dberr("csv import"))?;
        for c in &r.cells {
            tx.execute(
                "INSERT INTO database_cells(row_id, field_id, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(row_id, field_id) DO UPDATE SET value = ?3",
                params![r.id, c.field_id, c.value],
            )
            .map_err(dberr("csv import"))?;
            cell_count += 1;
        }
    }
    tx.commit().map_err(dberr("csv import (commit)"))?;
    Ok((fields.len(), rows.len(), cell_count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::CsvCellIn;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::ensure_migrated(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1', 'w1', NULL, '表格', 'grid', '{}', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn cells_of(conn: &Connection, field_id: &str) -> Vec<CellLoadRow> {
        load_cells(conn, "v1")
            .unwrap()
            .into_iter()
            .filter(|c| c.field_id == field_id)
            .collect()
    }

    // ---------- 字段 ----------

    #[test]
    fn create_field_defaults_match_legacy_js_shape() {
        let conn = setup();
        let f = create_field(&conn, "v1", "f1", "text", None).unwrap();
        assert_eq!(f.name, "text"); // name 缺省 = 类型名
        assert_eq!(f.width, 180);
        assert_eq!(f.is_hidden, 0);
        assert_eq!(f.position, 0);
        assert_eq!(f.options, r#"{"kind":"none"}"#);

        let f2 = create_field(&conn, "v1", "f2", "single_select", Some("状态")).unwrap();
        assert_eq!(f2.name, "状态");
        assert_eq!(f2.position, 1);
        assert_eq!(f2.options, r#"{"kind":"select","options":[]}"#);
    }

    #[test]
    fn default_options_per_type() {
        assert_eq!(
            default_options_json("number"),
            r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
        );
        assert_eq!(
            default_options_json("date"),
            r#"{"include_time":false,"kind":"date"}"#
        );
        assert_eq!(
            default_options_json("multi_select"),
            r#"{"kind":"select","options":[]}"#
        );
        assert_eq!(default_options_json("checkbox"), r#"{"kind":"none"}"#);
        assert_eq!(
            default_options_json("relation"),
            r#"{"kind":"relation","target_view_id":""}"#
        );
        assert_eq!(
            default_options_json("rollup"),
            r#"{"fn":"count","kind":"rollup","relation_field_id":"","target_field_id":""}"#
        );
        assert_eq!(
            default_options_json("reverse_relation"),
            r#"{"kind":"reverse_relation","source_field_id":"","source_view_id":""}"#
        );
        assert_eq!(default_options_json("attachment"), r#"{"kind":"none"}"#);
    }

    /// 读契约文件（前端测试读同一份），返回 types 数组与触发器时间戳列表
    fn read_contract() -> (Vec<serde_json::Value>, Vec<String>) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../contracts/field_type_contract.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读不到契约文件 {}: {e}", path.display()));
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("契约文件应是合法 JSON");
        let types = doc["types"]
            .as_array()
            .expect("契约的 types 应是数组")
            .clone();
        let timestamps = doc["triggerManagedTimestampTypes"]
            .as_array()
            .expect("契约的 triggerManagedTimestampTypes 应是数组")
            .iter()
            .map(|v| v.as_str().expect("每项应是字符串").to_string())
            .collect();
        (types, timestamps)
    }

    #[test]
    fn default_options_match_shared_contract() {
        let (entries, _) = read_contract();
        assert!(!entries.is_empty(), "契约里一个类型都没有，测试就形同虚设");
        for entry in &entries {
            let field_type = entry["type"].as_str().expect("每项要有 type");
            let want = &entry["defaultOptions"];
            let got: serde_json::Value = serde_json::from_str(&default_options_json(field_type))
                .expect("默认 options 应是合法 JSON");
            assert_eq!(
                got,
                want.clone(),
                "{field_type} 的默认 options 与契约不一致"
            );
        }
    }

    /// 复制视图时跳过源单元格的类型清单，必须与契约（及前端认知）一致
    #[test]
    fn trigger_managed_timestamps_match_shared_contract() {
        let (_, timestamps) = read_contract();
        let expected: Vec<String> = TRIGGER_MANAGED_TIMESTAMPS
            .iter()
            .map(|t| t.to_string())
            .collect();
        assert_eq!(
            timestamps, expected,
            "views::crud 跳过的时间戳列与契约不一致"
        );
    }

    #[test]
    fn field_update_ops() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", Some("名")).unwrap();

        rename_field(&conn, "f1", "新名").unwrap();
        set_field_width(&conn, "f1", 240).unwrap();
        set_field_hidden(&conn, "f1", true).unwrap();
        update_field_options(&conn, "f1", r#"{"kind":"number"}"#).unwrap();

        let fs = list_fields(&conn, "v1").unwrap();
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].name, "新名");
        assert_eq!(fs[0].width, 240);
        assert_eq!(fs[0].is_hidden, 1);
        assert_eq!(fs[0].options, r#"{"kind":"number"}"#);
    }

    #[test]
    fn rename_field_of_missing_id_errors() {
        // 悬空/跨视图 field_id 不能静默 no-op：前端会带着旧名乐观更新，公式连锁整条走空
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        let err = rename_field(&conn, "ghost", "幽灵").unwrap_err();
        assert!(err.contains("ghost"), "报错需带上缺失的字段 id：{err}");
        // 真实字段不受影响
        assert_eq!(list_fields(&conn, "v1").unwrap()[0].name, "text");
    }

    #[test]
    fn reorder_fields_assigns_final_positions() {
        let conn = setup();
        for id in ["f1", "f2", "f3"] {
            create_field(&conn, "v1", id, "text", None).unwrap();
        }
        reorder_fields(&conn, "v1", &["f3", "f1", "f2"]).unwrap();
        let fs = list_fields(&conn, "v1").unwrap();
        let order: Vec<&str> = fs.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(order, vec!["f3", "f1", "f2"]);
        let positions: Vec<i64> = fs.iter().map(|f| f.position).collect();
        assert_eq!(positions, vec![0, 1, 2]);
    }

    #[test]
    fn change_field_type_resets_options_and_clears_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""hello""#).unwrap();

        change_field_type(&conn, "f1", "number").unwrap();

        let f = &list_fields(&conn, "v1").unwrap()[0];
        assert_eq!(f.field_type, "number");
        assert_eq!(
            f.options,
            r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
        );
        let f1_cells = cells_of(&conn, "f1");
        assert_eq!(f1_cells.len(), 1); // 行还在，单元格没被删
        assert_eq!(f1_cells[0].value, "null");
    }

    /// 改类型不再是一去无回头的清空：旧值连同字段定义留着，撤销能原样换回
    #[test]
    fn change_field_type_snapshot_restores_values_and_definition() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        create_row(&conn, "v1", "r2", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""甲""#).unwrap();
        set_cell(&conn, "r2", "f1", r#""乙""#).unwrap();
        let definition_before = list_fields(&conn, "v1").unwrap()[0].clone();

        assert_eq!(change_field_type(&conn, "f1", "number").unwrap(), 2);
        let cleared: Vec<String> = cells_of(&conn, "f1").into_iter().map(|c| c.value).collect();
        assert_eq!(cleared, vec!["null".to_string(), "null".to_string()]);

        assert_eq!(restore_field_values(&conn, "f1").unwrap(), 2);
        let back = &list_fields(&conn, "v1").unwrap()[0];
        assert_eq!(
            back.field_type, definition_before.field_type,
            "类型要换回去"
        );
        assert_eq!(
            back.options, definition_before.options,
            "options 也要换回去"
        );
        let values: Vec<String> = cells_of(&conn, "f1").into_iter().map(|c| c.value).collect();
        assert_eq!(values, vec![r#""甲""#.to_string(), r#""乙""#.to_string()]);

        // 还原即消费：快照没了，再点撤销不该把同一份旧值反复盖回来
        assert!(restore_field_values(&conn, "f1").is_err());
    }

    /// 连续改类型时，空列不该把上一次留存的旧值顶掉（A 有值→B 空→C：还能拿回 A）
    #[test]
    fn change_field_type_keeps_earlier_snapshot_when_column_is_empty() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""别丢""#).unwrap();

        assert_eq!(change_field_type(&conn, "f1", "number").unwrap(), 1);
        // 这一列现在全是 null，再改一次类型没什么可留存
        assert_eq!(change_field_type(&conn, "f1", "single_select").unwrap(), 0);
        assert_eq!(restore_field_values(&conn, "f1").unwrap(), 1);
        let f = &list_fields(&conn, "v1").unwrap()[0];
        assert_eq!(f.field_type, "text", "还原回的是最初有值时的类型");
        assert_eq!(cells_of(&conn, "f1")[0].value, r#""别丢""#);
    }

    #[test]
    fn restore_field_values_skips_rows_deleted_after_the_snapshot() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        create_row(&conn, "v1", "r2", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""留""#).unwrap();
        set_cell(&conn, "r2", "f1", r#""没""#).unwrap();
        change_field_type(&conn, "f1", "number").unwrap();
        // 期间删掉一行：那一格的取值没有归属的行，插回去会撞 cells.row_id 的外键
        purge_rows(&conn, &["r2".to_string()]).unwrap();

        assert_eq!(restore_field_values(&conn, "f1").unwrap(), 1);
        let values: Vec<(String, String)> = cells_of(&conn, "f1")
            .into_iter()
            .map(|c| (c.row_id, c.value))
            .collect();
        assert_eq!(values, vec![("r1".to_string(), r#""留""#.to_string())]);
    }

    #[test]
    fn change_field_type_same_type_is_noop() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""hello""#).unwrap();
        let options_before = list_fields(&conn, "v1").unwrap()[0].options.clone();

        change_field_type(&conn, "f1", "text").unwrap();

        let f = &list_fields(&conn, "v1").unwrap()[0];
        assert_eq!(f.field_type, "text");
        assert_eq!(f.options, options_before); // 选项未被重置
        assert_eq!(cells_of(&conn, "f1")[0].value, r#""hello""#); // 数据未清空
    }

    #[test]
    fn delete_field_cascades_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""x""#).unwrap();

        delete_field(&conn, "f1").unwrap();
        assert!(list_fields(&conn, "v1").unwrap().is_empty());
        assert!(load_cells(&conn, "v1").unwrap().is_empty());
    }

    // ---------- 关联列自动配对反向列 ----------

    fn add_view(conn: &Connection, id: &str, name: &str, source_id: Option<&str>) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at, source_id)
             VALUES (?1, 'w1', NULL, ?2, 'grid', '{}', 0, 1, 1, ?3)",
            params![id, name, source_id],
        )
        .unwrap();
    }

    fn options_of(conn: &Connection, field_id: &str) -> serde_json::Value {
        let raw: String = conn
            .query_row(
                "SELECT options FROM database_fields WHERE id = ?1",
                params![field_id],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn count_fields(conn: &Connection, view_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM database_fields WHERE database_view_id = ?1",
            params![view_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn view_of_field(conn: &Connection, field_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT database_view_id FROM database_fields WHERE id = ?1",
            params![field_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn pair_relation_creates_reverse_column_on_target() {
        let conn = setup();
        add_view(&conn, "v2", "对端", None);
        create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();

        let out = pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();

        assert_eq!(out.reverse_field_id, "rv1");
        assert_eq!(
            out.relation_field.options,
            options_of(&conn, "f1").to_string()
        );
        let rel = options_of(&conn, "f1");
        assert_eq!(rel["kind"], "relation");
        assert_eq!(rel["target_view_id"], "v2");
        assert_eq!(rel["paired_field_id"], "rv1");
        // 反向列落在目标表上，类型与配置都要能直接被反向关系渲染认账
        assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
        let rev = options_of(&conn, "rv1");
        assert_eq!(rev["kind"], "reverse_relation");
        assert_eq!(rev["source_view_id"], "v1");
        assert_eq!(rev["source_field_id"], "f1");
        let rev_type: String = conn
            .query_row(
                "SELECT field_type FROM database_fields WHERE id = 'rv1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rev_type, "reverse_relation");
        assert_eq!(count_fields(&conn, "v2"), 1);
    }

    #[test]
    fn pair_relation_reuses_untouched_reverse_column() {
        let conn = setup();
        add_view(&conn, "v2", "对端", None);
        create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
        pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();

        // 反复打开字段设置（或同一次会话里再保存一遍）不该在对端堆出同义列
        let out = pair_relation_field(&conn, "f1", "v2", "rv2", "反向").unwrap();
        assert_eq!(out.reverse_field_id, "rv1");
        assert_eq!(options_of(&conn, "f1")["paired_field_id"], "rv1");
        assert_eq!(count_fields(&conn, "v2"), 1);
        assert_eq!(view_of_field(&conn, "rv2"), None);
    }

    #[test]
    fn pair_retarget_drops_the_zombie_reverse_column() {
        let conn = setup();
        add_view(&conn, "v2", "旧对端", None);
        add_view(&conn, "v3", "新对端", None);
        create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
        pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();

        let out = pair_relation_field(&conn, "f1", "v3", "rv2", "反向").unwrap();

        assert_eq!(out.reverse_field_id, "rv2");
        assert_eq!(view_of_field(&conn, "rv1"), None, "改指后旧反向列已失效");
        assert_eq!(count_fields(&conn, "v2"), 0);
        assert_eq!(view_of_field(&conn, "rv2").as_deref(), Some("v3"));
        assert_eq!(options_of(&conn, "f1")["target_view_id"], "v3");
    }

    #[test]
    fn pair_retarget_keeps_a_customized_reverse_column() {
        let conn = setup();
        add_view(&conn, "v2", "旧对端", None);
        add_view(&conn, "v3", "新对端", None);
        create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
        pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();
        // 用户改了这条反向列的配置（这里改成指向另一个来源字段）：它已经是用户的数据，不能删
        update_field_options(
            &conn,
            "rv1",
            r#"{"kind":"reverse_relation","source_view_id":"v1","source_field_id":"other"}"#,
        )
        .unwrap();

        let out = pair_relation_field(&conn, "f1", "v3", "rv2", "反向").unwrap();

        assert_eq!(out.reverse_field_id, "rv2");
        assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
    }

    #[test]
    fn pair_relation_rejects_bad_targets() {
        let conn = setup();
        add_view(&conn, "v2", "对端", None);
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_field(&conn, "v1", "f2", "relation", None).unwrap();

        let not_relation = pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap_err();
        assert!(not_relation.contains("不是关联列"), "{not_relation}");
        let missing = pair_relation_field(&conn, "f2", "v9", "rv1", "反向").unwrap_err();
        assert!(missing.contains("不存在"), "{missing}");
        let empty = pair_relation_field(&conn, "f2", "", "rv1", "反向").unwrap_err();
        assert!(empty.contains("还没有选择目标表"), "{empty}");
        assert_eq!(count_fields(&conn, "v2"), 0, "失败不该留下半配对");
    }

    #[test]
    fn pair_relation_folds_derived_target_view_to_host() {
        let conn = setup();
        add_view(&conn, "v2", "宿主表", None);
        add_view(&conn, "v2d", "派生视图", Some("v2"));
        create_field(&conn, "v1", "f1", "relation", None).unwrap();

        let out = pair_relation_field(&conn, "f1", "v2d", "rv1", "反向").unwrap();

        // 数据和反向列都只挂宿主：派生视图背后没有独立的字段表
        assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
        assert_eq!(options_of(&conn, "f1")["target_view_id"], "v2");
        assert_eq!(out.reverse_field_id, "rv1");
    }

    #[test]
    fn delete_relation_field_removes_untouched_paired_reverse() {
        let conn = setup();
        add_view(&conn, "v2", "对端", None);
        create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
        pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();
        create_row(&conn, "v2", "t1", None).unwrap();
        set_cell(&conn, "t1", "rv1", r#"["r1"]"#).unwrap();

        delete_field(&conn, "f1").unwrap();

        assert_eq!(view_of_field(&conn, "rv1"), None);
        assert_eq!(count_fields(&conn, "v2"), 0);
        // 反向列的单元格随列一起走 FK 级联
        assert!(load_cells(&conn, "v2").unwrap().is_empty());
    }

    #[test]
    fn delete_relation_field_keeps_customized_paired_reverse() {
        let conn = setup();
        add_view(&conn, "v2", "对端", None);
        create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
        pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();
        rename_field(&conn, "rv1", "谁关联了我").unwrap();
        update_field_options(
            &conn,
            "rv1",
            r#"{"kind":"reverse_relation","source_view_id":"v9","source_field_id":"f1"}"#,
        )
        .unwrap();

        delete_field(&conn, "f1").unwrap();

        assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
    }

    // ---------- 行 ----------

    #[test]
    fn row_crud_and_document_binding() {
        let conn = setup();
        let r = create_row(&conn, "v1", "r1", None).unwrap();
        assert_eq!(r.position, 0);
        assert_eq!(r.document_id, None);
        assert_eq!(r.created_at, r.updated_at);

        create_row(&conn, "v1", "r2", None).unwrap();

        let got = get_row(&conn, "r1").unwrap().unwrap();
        assert_eq!(got.id, "r1");
        assert!(get_row(&conn, "ghost").unwrap().is_none());

        set_row_document_id(&conn, "r1", "doc-1").unwrap();
        assert_eq!(
            get_row(&conn, "r1")
                .unwrap()
                .unwrap()
                .document_id
                .as_deref(),
            Some("doc-1")
        );

        purge_rows(&conn, &["r2".into()]).unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r1");
    }

    /// 父子行层级：parent_id 随行模型读写，父行被彻底删除时子行脱钩回顶层（FK SET NULL）。
    #[test]
    fn row_parent_roundtrip_and_detach_on_purge() {
        let conn = setup();
        create_row(&conn, "v1", "r1", None).unwrap();
        let child = create_row(&conn, "v1", "r2", Some("r1")).unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("r1"));
        assert_eq!(
            get_row(&conn, "r2").unwrap().unwrap().parent_id.as_deref(),
            Some("r1")
        );
        let parents: Vec<Option<String>> = list_rows(&conn, "v1")
            .unwrap()
            .into_iter()
            .map(|r| r.parent_id)
            .collect();
        assert_eq!(parents, vec![None, Some("r1".into())]);

        purge_rows(&conn, &["r1".into()]).unwrap();
        assert_eq!(
            get_row(&conn, "r2").unwrap().unwrap().parent_id,
            None,
            "父行彻底删除后子行要回到顶层，而不是挂着幽灵父引用"
        );

        set_row_parent(&conn, "r2", None).unwrap();
        assert_eq!(get_row(&conn, "r2").unwrap().unwrap().parent_id, None);
    }

    /// 非法父行一律拒绝：自己、后代（成环）、别的表、回收站里的行、不存在的 id。
    #[test]
    fn set_row_parent_rejects_invalid_parents() {
        let conn = setup();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v2', 'w1', NULL, '第二张表', 'grid', '{}', 2, 1, 1)",
            [],
        )
        .unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        create_row(&conn, "v1", "r2", Some("r1")).unwrap();
        create_row(&conn, "v2", "r3", None).unwrap();

        assert!(set_row_parent(&conn, "r1", Some("r1"))
            .unwrap_err()
            .contains("own parent"));
        assert!(set_row_parent(&conn, "r1", Some("r2"))
            .unwrap_err()
            .contains("own descendant"));
        assert!(set_row_parent(&conn, "r2", Some("r3"))
            .unwrap_err()
            .contains("another table"));
        assert!(set_row_parent(&conn, "r2", Some("ghost"))
            .unwrap_err()
            .contains("not found"));

        // 幂等：父行没变就直接返回，连校验和 updated_at 都不碰
        let before = get_row(&conn, "r2").unwrap().unwrap().updated_at;
        set_row_parent(&conn, "r2", Some("r1")).unwrap();
        assert_eq!(get_row(&conn, "r2").unwrap().unwrap().updated_at, before);

        // 父行进了回收站也不能再被选中（它已经不在可见行集合里）
        create_row(&conn, "v1", "r4", None).unwrap();
        soft_delete_rows(&conn, &["r1".into()]).unwrap();
        assert!(set_row_parent(&conn, "r4", Some("r1"))
            .unwrap_err()
            .contains("in trash"));
    }

    /// 深度限额 4 层：新建第 5 层被挡，整棵子树搬深时被搬子树的最深一条线也要计入。
    #[test]
    fn row_hierarchy_stops_at_the_depth_limit() {
        let conn = setup();
        create_row(&conn, "v1", "l1", None).unwrap();
        create_row(&conn, "v1", "l2", Some("l1")).unwrap();
        create_row(&conn, "v1", "l3", Some("l2")).unwrap();
        create_row(&conn, "v1", "l4", Some("l3")).unwrap();
        assert!(create_row(&conn, "v1", "l5", Some("l4"))
            .unwrap_err()
            .contains("depth"));
        assert!(set_row_parent(&conn, "l3", Some("l4"))
            .unwrap_err()
            .contains("descendant"));

        // l2 下面挂着 l3、l4（子树高 2），搬到第 1 层行之下最深到第 4 行仍然允许
        create_row(&conn, "v1", "x1", None).unwrap();
        set_row_parent(&conn, "l2", Some("x1")).unwrap();
        assert_eq!(
            get_row(&conn, "l4").unwrap().unwrap().parent_id.as_deref(),
            Some("l3"),
            "改父行只动被搬那一行，子树跟着走是层级结构本身的语义"
        );

        // 同一棵子树搬到第 2 层行之下会最深到第 5 层：按深度拒绝，不是因为成环
        create_row(&conn, "v1", "y1", None).unwrap();
        create_row(&conn, "v1", "y2", Some("y1")).unwrap();
        let err = set_row_parent(&conn, "l2", Some("y2")).unwrap_err();
        assert!(err.contains("depth"), "{err}");
        assert_eq!(
            get_row(&conn, "l2").unwrap().unwrap().parent_id.as_deref(),
            Some("x1"),
            "被拒绝的改动不能留下半个层级"
        );
    }

    /// trg_cells_row_inserted：视图已有 created_at/last_edited_at 字段时，插行自动补时间戳单元格
    #[test]
    fn row_insert_trigger_fills_timestamp_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f-created", "created_at", None).unwrap();
        create_field(&conn, "v1", "f-edited", "last_edited_at", None).unwrap();

        create_row(&conn, "v1", "r1", None).unwrap();

        let created = cells_of(&conn, "f-created");
        assert_eq!(created.len(), 1);
        assert!(
            created[0].value.ends_with('Z'),
            "UTC ISO 秒级: {}",
            created[0].value
        );
        let edited = cells_of(&conn, "f-edited");
        assert_eq!(edited.len(), 1);
    }

    #[test]
    fn reorder_rows_assigns_final_positions() {
        let conn = setup();
        for id in ["r1", "r2", "r3"] {
            create_row(&conn, "v1", id, None).unwrap();
        }
        reorder_rows(&conn, "v1", &["r2", "r3", "r1"]).unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        let order: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(order, vec!["r2", "r3", "r1"]);
    }

    #[test]
    fn purge_row_cascades_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        set_cell(&conn, "r1", "f1", r#""x""#).unwrap();

        purge_rows(&conn, &["r1".into()]).unwrap();
        assert!(list_rows(&conn, "v1").unwrap().is_empty());
        assert!(load_cells(&conn, "v1").unwrap().is_empty());
    }

    // ---------- 单元格 ----------

    #[test]
    fn load_cells_empty_then_upsert() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        assert!(load_cells(&conn, "v1").unwrap().is_empty());

        set_cell(&conn, "r1", "f1", r#""a""#).unwrap();
        let cells = cells_of(&conn, "f1");
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].row_id, "r1");
        assert_eq!(cells[0].value, r#""a""#);

        set_cell(&conn, "r1", "f1", r#""b""#).unwrap(); // upsert 覆盖，不产生第二行
        let cells = cells_of(&conn, "f1");
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].value, r#""b""#);
    }

    /// trg_cells_value_changed：值 UPDATE 且变化时刷新行 updated_at（INSERT 路径不触发）
    #[test]
    fn cell_update_trigger_refreshes_row_timestamp() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();

        // 手动把 updated_at 设到过去，观察触发器是否刷回当前时间
        conn.execute(
            "UPDATE database_rows SET updated_at = 12345 WHERE id = 'r1'",
            [],
        )
        .unwrap();

        set_cell(&conn, "r1", "f1", r#""a""#).unwrap(); // INSERT 路径
        assert_eq!(get_row(&conn, "r1").unwrap().unwrap().updated_at, 12345);

        set_cell(&conn, "r1", "f1", r#""b""#).unwrap(); // UPDATE 路径
        assert!(
            get_row(&conn, "r1").unwrap().unwrap().updated_at > 12345,
            "触发器应刷新 updated_at"
        );

        // 值相同再写一遍：WHEN old.value IS NOT new.value 不触发，不空转
        conn.execute(
            "UPDATE database_rows SET updated_at = 12345 WHERE id = 'r1'",
            [],
        )
        .unwrap();
        set_cell(&conn, "r1", "f1", r#""b""#).unwrap();
        assert_eq!(get_row(&conn, "r1").unwrap().unwrap().updated_at, 12345);
    }

    #[test]
    fn set_cell_fk_guard() {
        let conn = setup();
        let err = set_cell(&conn, "ghost-row", "ghost-field", "1").unwrap_err();
        assert!(err.contains("FOREIGN KEY"), "{err}");
    }

    // ---------- 批量写（TSV 粘贴路径） ----------

    fn cell_set_in(row: &str, field: &str, value: &str) -> CellSetIn {
        CellSetIn {
            row_id: row.into(),
            field_id: field.into(),
            value: value.into(),
        }
    }

    #[test]
    fn set_cells_many_upserts_and_rolls_back_atomically() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();

        let n = set_cells_many(
            &conn,
            &[
                cell_set_in("r1", "f1", r#""a""#),
                cell_set_in("r1", "f1", r#""b""#), // 同格后写覆盖先写
            ],
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(cells_of(&conn, "f1")[0].value, r#""b""#);

        // 任一条 FK 违例 → 整批回滚，先写入的合法项也不落库
        let err = set_cells_many(
            &conn,
            &[
                cell_set_in("r1", "f1", r#""c""#),
                cell_set_in("ghost", "f1", "1"),
            ],
        )
        .unwrap_err();
        assert!(err.contains("FOREIGN KEY"), "{err}");
        assert_eq!(cells_of(&conn, "f1")[0].value, r#""b""#);
    }

    #[test]
    fn create_rows_appends_positions_and_rolls_back_on_duplicate() {
        let conn = setup();
        create_row(&conn, "v1", "r1", None).unwrap();

        let made = create_rows(&conn, "v1", &["r2".into(), "r3".into()]).unwrap();
        assert_eq!(
            made.iter().map(|r| r.position).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(made[1].database_view_id, "v1");
        assert_eq!(list_rows(&conn, "v1").unwrap().len(), 3);

        let err = create_rows(&conn, "v1", &["r4".into(), "r2".into()]).unwrap_err();
        assert!(err.contains("UNIQUE"), "{err}");
        let ids: Vec<String> = list_rows(&conn, "v1")
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["r1", "r2", "r3"], "整批回滚：r4 不落库");
    }

    #[test]
    fn purge_rows_removes_all_and_cascades_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_rows(&conn, "v1", &["r1".into(), "r2".into(), "r3".into()]).unwrap();
        set_cells_many(
            &conn,
            &[
                CellSetIn {
                    row_id: "r2".into(),
                    field_id: "f1".into(),
                    value: r#""x""#.into(),
                },
                CellSetIn {
                    row_id: "r3".into(),
                    field_id: "f1".into(),
                    value: r#""y""#.into(),
                },
            ],
        )
        .unwrap();

        // 多选删除：已不存在的 id 不计入、也不中断整批
        let n = purge_rows(&conn, &["r2".into(), "ghost".into()]).unwrap();
        assert_eq!(n, 1);
        let ids: Vec<String> = list_rows(&conn, "v1")
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["r1", "r3"]);
        let left = cells_of(&conn, "f1");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].row_id, "r3", "r2 的单元格随行级联删除");
    }

    /// 删除后剩余行 position 压紧 0..n-1：行号列按 position 显示，不跳号
    #[test]
    fn delete_compacts_row_positions() {
        let conn = setup();
        create_rows(
            &conn,
            "v1",
            &["r1".into(), "r2".into(), "r3".into(), "r4".into()],
        )
        .unwrap();

        purge_rows(&conn, &["r2".into()]).unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| (r.id.as_str(), r.position))
                .collect::<Vec<_>>(),
            vec![("r1", 0), ("r3", 1), ("r4", 2)]
        );

        // 批量删除（含缺 id）同样压紧
        purge_rows(&conn, &["r1".into(), "ghost".into()]).unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| (r.id.as_str(), r.position))
                .collect::<Vec<_>>(),
            vec![("r3", 0), ("r4", 1)]
        );
    }

    // ---------- 行回收站 ----------

    /// 读原始标记列：list_rows/list_trash_rows 已经按 is_trash 过滤，测试要看底层真实状态
    fn trash_flag(conn: &Connection, row_id: &str) -> i64 {
        conn.query_row(
            "SELECT is_trash FROM database_rows WHERE id = ?1",
            params![row_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn seed_doc_view(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', 'v1', '行详情', 'document', '{\"row_detail\":true}', 1, 1, 1)",
            params![id],
        )
        .unwrap();
    }

    fn doc_trash_flag(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT is_trash FROM views WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn soft_delete_hides_row_but_keeps_cells() {
        let conn = setup();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_rows(&conn, "v1", &["r1".into(), "r2".into(), "r3".into()]).unwrap();
        set_cell(&conn, "r2", "f1", r#""任务 B""#).unwrap();

        let n = soft_delete_rows(&conn, &["r2".into(), "ghost".into()]).unwrap();
        assert_eq!(n, 1, "不存在的 id 不计入，也不中断整批");

        let ids: Vec<String> = list_rows(&conn, "v1")
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(
            ids,
            vec!["r1", "r3"],
            "剩下的行压紧行号，回收站里的行不再出现"
        );
        assert_eq!(
            list_rows(&conn, "v1")
                .unwrap()
                .iter()
                .map(|r| r.position)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert!(
            load_cells(&conn, "v1").unwrap().is_empty(),
            "r2 的单元格读不到"
        );
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM database_cells", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "软删只是打标记，单元格留在库里等着恢复");

        let trash = list_trash_rows(&conn, "v1").unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, "r2");
        assert_eq!(trash[0].title, "任务 B", "列表要能认出删掉的是哪一行");
        assert!(trash[0].deleted_at.is_some());

        // 重复软删同一行不计数（幂等，前端重试安全）
        assert_eq!(soft_delete_rows(&conn, &["r2".into()]).unwrap(), 0);
        assert_eq!(trash_flag(&conn, "r2"), 1);
    }

    #[test]
    fn restore_row_appends_it_at_the_end() {
        let conn = setup();
        create_rows(
            &conn,
            "v1",
            &["r1".into(), "r2".into(), "r3".into(), "r4".into()],
        )
        .unwrap();
        soft_delete_rows(&conn, &["r2".into()]).unwrap();
        // 回收站期间又删掉一行并新增一行，原 position 早已不属于它
        soft_delete_rows(&conn, &["r3".into()]).unwrap();
        create_row(&conn, "v1", "r5", None).unwrap();

        restore_row(&conn, "r2").unwrap();
        let rows = list_rows(&conn, "v1").unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| (r.id.as_str(), r.position))
                .collect::<Vec<_>>(),
            vec![("r1", 0), ("r4", 1), ("r5", 2), ("r2", 3)],
            "恢复排在可见行末尾，行号连续不撞号"
        );
        assert_eq!(trash_flag(&conn, "r2"), 0);
        assert!(list_trash_rows(&conn, "v1")
            .unwrap()
            .iter()
            .all(|t| t.id != "r2"));

        let err = restore_row(&conn, "r2").unwrap_err();
        assert!(err.contains("r2"), "重复恢复要报错而不是静默：{err}");
    }

    #[test]
    fn row_document_follows_the_row_into_and_out_of_trash() {
        let conn = setup();
        create_row(&conn, "v1", "r1", None).unwrap();
        seed_doc_view(&conn, "d1");
        set_row_document_id(&conn, "r1", "d1").unwrap();

        soft_delete_rows(&conn, &["r1".into()]).unwrap();
        assert_eq!(
            doc_trash_flag(&conn, "d1"),
            1,
            "行删了，详情文档不能再被搜到"
        );

        restore_row(&conn, "r1").unwrap();
        assert_eq!(doc_trash_flag(&conn, "d1"), 0);

        // 详情文档也会被「页面回收站的自动清空」连带删掉：恢复行时 document_id 要清成 NULL，
        // 否则下次打开行详情会拿着悬空 id 报 "row detail view missing"
        soft_delete_rows(&conn, &["r1".into()]).unwrap();
        crate::db::views::purge_expired_trash(&conn, "w1", i64::MAX).unwrap();
        restore_row(&conn, "r1").unwrap();
        assert_eq!(
            get_row(&conn, "r1").unwrap().unwrap().document_id,
            None,
            "文档已被清空时不留悬空引用"
        );

        // 彻底删除：文档一并清掉，不留 hidden 孤儿页
        soft_delete_rows(&conn, &["r1".into()]).unwrap();
        purge_rows(&conn, &["r1".into()]).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM views WHERE id = 'd1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 0, "行彻底删除时行详情文档也要消失");
    }

    #[test]
    fn purge_trash_rows_empties_one_table_only() {
        let conn = setup();
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v2', 'w1', NULL, '第二张表', 'grid', '{}', 2, 1, 1)",
            [],
        )
        .unwrap();
        create_field(&conn, "v1", "f1", "text", None).unwrap();
        create_field(&conn, "v2", "f2", "text", None).unwrap();
        create_row(&conn, "v1", "r1", None).unwrap();
        create_row(&conn, "v2", "r2", None).unwrap();
        soft_delete_rows(&conn, &["r1".into(), "r2".into()]).unwrap();

        let n = purge_trash_rows(&conn, "v1").unwrap();
        assert_eq!(n, 1);
        assert!(list_trash_rows(&conn, "v1").unwrap().is_empty());
        assert_eq!(
            list_trash_rows(&conn, "v2").unwrap().len(),
            1,
            "别表的回收站不受影响"
        );
        let cells: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM database_cells WHERE row_id = 'r1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cells, 0, "彻底删除才走 FK 级联清单元格");
    }

    #[test]
    fn purge_expired_trash_rows_respects_the_deadline() {
        let conn = setup();
        create_rows(&conn, "v1", &["r1".into(), "r2".into()]).unwrap();
        soft_delete_rows(&conn, &["r1".into(), "r2".into()]).unwrap();
        conn.execute(
            "UPDATE database_rows SET deleted_at = 1000 WHERE id = 'r1'",
            [],
        )
        .unwrap();

        let n = purge_expired_trash_rows(&conn, 5000).unwrap();
        assert_eq!(n, 1, "只清过期的一条");
        let left: Vec<String> = list_trash_rows(&conn, "v1")
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(left, vec!["r2"]);
    }

    // ---------- CSV 导入 ----------

    #[test]
    fn csv_import_lands_everything_in_one_transaction() {
        let conn = setup();
        let fields = vec![
            CsvFieldIn {
                id: "f1".into(),
                name: "名称".into(),
                field_type: "text".into(),
                options: None,
            },
            CsvFieldIn {
                id: "f2".into(),
                name: "数量".into(),
                field_type: "number".into(),
                options: None,
            },
        ];
        let rows = vec![
            CsvRowIn {
                id: "r1".into(),
                cells: vec![
                    CsvCellIn {
                        field_id: "f1".into(),
                        value: r#""a""#.into(),
                    },
                    CsvCellIn {
                        field_id: "f2".into(),
                        value: "1".into(),
                    },
                ],
            },
            CsvRowIn {
                id: "r2".into(),
                cells: vec![],
            },
        ];
        let (nf, nr, nc) = csv_import(&conn, "v1", &fields, &rows).unwrap();
        assert_eq!((nf, nr, nc), (2, 2, 2));

        let fs = list_fields(&conn, "v1").unwrap();
        assert_eq!(
            fs.iter().map(|f| f.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(
            fs[1].options,
            r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
        );
        let rs = list_rows(&conn, "v1").unwrap();
        assert_eq!(
            rs.iter().map(|r| r.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(load_cells(&conn, "v1").unwrap().len(), 2);
    }

    #[test]
    fn csv_import_rolls_back_on_bad_field_type() {
        let conn = setup();
        let fields = vec![
            CsvFieldIn {
                id: "f1".into(),
                name: "ok".into(),
                field_type: "text".into(),
                options: None,
            },
            CsvFieldIn {
                id: "f2".into(),
                name: "bad".into(),
                field_type: "ghost_type".into(),
                options: None,
            }, // CHECK 约束拒绝
        ];
        let rows = vec![CsvRowIn {
            id: "r1".into(),
            cells: vec![],
        }];
        let err = csv_import(&conn, "v1", &fields, &rows).unwrap_err();
        assert!(err.contains("CHECK"), "{err}");
        // 整体回滚：合法的 f1 也不存在
        assert!(list_fields(&conn, "v1").unwrap().is_empty());
        assert!(list_rows(&conn, "v1").unwrap().is_empty());
    }

    #[test]
    fn csv_import_lands_provided_options_for_select_fields() {
        let conn = setup();
        let fields = vec![CsvFieldIn {
            id: "f1".into(),
            name: "状态".into(),
            field_type: "single_select".into(),
            options: Some(
                r#"{"kind":"select","options":[{"id":"o1","name":"进行中","color":"blue"}]}"#
                    .into(),
            ),
        }];
        let rows = vec![CsvRowIn {
            id: "r1".into(),
            cells: vec![CsvCellIn {
                field_id: "f1".into(),
                value: r#""o1""#.into(),
            }],
        }];
        csv_import(&conn, "v1", &fields, &rows).unwrap();
        let fs = list_fields(&conn, "v1").unwrap();
        assert_eq!(
            fs[0].options,
            r#"{"kind":"select","options":[{"id":"o1","name":"进行中","color":"blue"}]}"#
        );
    }

    // ---------- 多视图：派生视图 id 折算到宿主 ----------

    fn derive(conn: &Connection, id: &str, host: &str, layout: &str) {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at, source_id)
             VALUES (?1, 'w1', NULL, ?1, ?2, '{}', 0, 1, 1, ?3)",
            params![id, layout, host],
        )
        .unwrap();
    }

    #[test]
    fn data_view_id_maps_derived_to_host_and_passes_others_through() {
        let conn = setup();
        derive(&conn, "v1-board", "v1", "board");
        assert_eq!(data_view_id(&conn, "v1-board").unwrap(), "v1");
        assert_eq!(data_view_id(&conn, "v1").unwrap(), "v1", "宿主折算到自己");
        // 视图行不存在时原样返回：查询得到空集，不在已删视图的残留标签页上报错
        assert_eq!(data_view_id(&conn, "ghost").unwrap(), "ghost");
    }

    #[test]
    fn every_view_id_entry_point_resolves_to_the_host() {
        let conn = setup();
        derive(&conn, "v1-board", "v1", "board");
        let derived = "v1-board";

        let f = create_field(&conn, derived, "f1", "text", Some("名称")).unwrap();
        assert_eq!(f.database_view_id, "v1", "返回行报告真实归属");
        assert_eq!(
            list_fields(&conn, derived).unwrap().len(),
            1,
            "派生视图读得到宿主字段"
        );

        let r = create_row(&conn, derived, "r1", None).unwrap();
        assert_eq!(r.database_view_id, "v1");
        set_cell(&conn, "r1", "f1", r#""x""#).unwrap();
        assert_eq!(load_cells(&conn, derived).unwrap().len(), 1);
        assert_eq!(
            list_rows(&conn, "v1").unwrap()[0].id,
            "r1",
            "宿主读得到派生视图建的行"
        );

        create_field(&conn, derived, "f2", "number", None).unwrap();
        reorder_fields(&conn, derived, &["f2", "f1"]).unwrap();
        let order: Vec<String> = list_fields(&conn, "v1")
            .unwrap()
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(order, vec!["f2", "f1"]);

        let fields = vec![CsvFieldIn {
            id: "f3".into(),
            name: "导入".into(),
            field_type: "text".into(),
            options: None,
        }];
        let rows = vec![CsvRowIn {
            id: "r3".into(),
            cells: vec![CsvCellIn {
                field_id: "f3".into(),
                value: r#""v""#.into(),
            }],
        }];
        let (nf, nr, nc) = csv_import(&conn, derived, &fields, &rows).unwrap();
        assert_eq!((nf, nr, nc), (1, 1, 1));
        assert_eq!(list_rows(&conn, "v1").unwrap().len(), 2);
    }
}
