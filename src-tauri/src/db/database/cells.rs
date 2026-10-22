// database_cells 领域函数，以及批量建行与 CSV 导入（从 database/mod.rs 原样搬入，逻辑未改）。
use rusqlite::{params, Connection};

use super::super::models::{CellLoadRow, CellSetIn, CsvFieldIn, CsvRowIn, DatabaseRowRow};
use super::super::views::data_view_id;
use super::super::{dberr, now_ms};
use super::{default_options_json, next_position};

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
