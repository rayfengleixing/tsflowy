// 表格三表命令：fields / rows / cells 与 CSV 导入（从 db/mod.rs 原样搬入，逻辑未改）。
// 共用的入口参数校验与 crate::db 导入留在父模块，这里用 super::* 取。
use super::*;

// ---------- database（grid/board 表格三表：fields / rows / cells） ----------

#[tauri::command]
pub async fn field_list(
    db: State<'_, Db>,
    view_id: String,
) -> Result<Vec<DatabaseFieldRow>, String> {
    let conn = db.read_conn()?;
    db::database::list_fields(&conn, &view_id)
}

#[tauri::command]
pub async fn field_create(
    db: State<'_, Db>,
    view_id: String,
    id: String,
    field_type: String,
    name: Option<String>,
) -> Result<DatabaseFieldRow, String> {
    // id 由前端 newId() 生成
    check_id(&id)?;
    if let Some(n) = &name {
        check_name(n)?;
    }
    let conn = db.write_conn()?;
    db::database::create_field(&conn, &view_id, &id, &field_type, name.as_deref())
}

#[tauri::command]
pub async fn field_rename(db: State<'_, Db>, field_id: String, name: String) -> Result<(), String> {
    check_name(&name)?;
    let conn = db.write_conn()?;
    db::database::rename_field(&conn, &field_id, &name)
}

#[tauri::command]
pub async fn field_delete(db: State<'_, Db>, field_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::delete_field(&conn, &field_id)
}

#[tauri::command]
pub async fn field_set_width(
    db: State<'_, Db>,
    field_id: String,
    width: i64,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::set_field_width(&conn, &field_id, width)
}

#[tauri::command]
pub async fn field_set_hidden(
    db: State<'_, Db>,
    field_id: String,
    hidden: bool,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::set_field_hidden(&conn, &field_id, hidden)
}

#[tauri::command]
pub async fn field_update_options(
    db: State<'_, Db>,
    field_id: String,
    options: String,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::update_field_options(&conn, &field_id, &options)
}

/// 关联列选定/改指目标表：在对端建（或复用）那条反向关系列，返回写回后的本列 + 反向列 id。
/// 两张表的写入必须原子，所以不能拆成「前端先 field_update_options 再建列」两步。
#[tauri::command]
pub async fn field_pair_relation(
    db: State<'_, Db>,
    field_id: String,
    target_view_id: String,
    reverse_id: String,
    reverse_name: String,
) -> Result<RelationPairOut, String> {
    check_id(&field_id)?;
    check_id(&reverse_id)?;
    check_name(&reverse_name)?;
    let conn = db.write_conn()?;
    db::database::pair_relation_field(
        &conn,
        &field_id,
        &target_view_id,
        &reverse_id,
        &reverse_name,
    )
}

#[tauri::command]
pub async fn field_reorder(
    db: State<'_, Db>,
    view_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    let ids: Vec<&str> = ordered_ids.iter().map(String::as_str).collect();
    db::database::reorder_fields(&conn, &view_id, &ids)
}

/// 改字段类型（清空整列前会留存该列取值），返回留存的单元格数；>0 时前端给撤销入口
#[tauri::command]
pub async fn field_change_type(
    db: State<'_, Db>,
    field_id: String,
    new_type: String,
) -> Result<i64, String> {
    let conn = db.write_conn()?;
    db::database::change_field_type(&conn, &field_id, &new_type)
}

/// 用留存的取值把字段还原回改类型之前，返回还原的单元格数
#[tauri::command]
pub async fn field_restore_values(db: State<'_, Db>, field_id: String) -> Result<i64, String> {
    let conn = db.write_conn()?;
    db::database::restore_field_values(&conn, &field_id)
}

#[tauri::command]
pub async fn row_list(db: State<'_, Db>, view_id: String) -> Result<Vec<DatabaseRowRow>, String> {
    let conn = db.read_conn()?;
    db::database::list_rows(&conn, &view_id)
}

#[tauri::command]
pub async fn row_create(
    db: State<'_, Db>,
    view_id: String,
    id: String,
    parent_id: Option<String>,
) -> Result<DatabaseRowRow, String> {
    // id 由前端 newId() 生成
    let conn = db.write_conn()?;
    db::database::create_row(&conn, &view_id, &id, parent_id.as_deref())
}

/// 改父行（parent_id 传 null = 升到顶层）；环与超深由 db 层挡下并返回错误文案
#[tauri::command]
pub async fn row_set_parent(
    db: State<'_, Db>,
    row_id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::set_row_parent(&conn, &row_id, parent_id.as_deref())
}

#[tauri::command]
pub async fn row_get(db: State<'_, Db>, row_id: String) -> Result<Option<DatabaseRowRow>, String> {
    let conn = db.read_conn()?;
    db::database::get_row(&conn, &row_id)
}

#[tauri::command]
pub async fn row_set_document_id(
    db: State<'_, Db>,
    row_id: String,
    document_id: String,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::set_row_document_id(&conn, &row_id, &document_id)
}

/// 删行 = 进回收站（可恢复）；彻底删除用 row_purge。
#[tauri::command]
pub async fn row_delete(db: State<'_, Db>, row_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::soft_delete_rows(&conn, std::slice::from_ref(&row_id))?;
    Ok(())
}

/// 批量删行（多选删除）：一次 IPC 一个事务；返回实际进回收站的行数。
#[tauri::command]
pub async fn row_delete_many(db: State<'_, Db>, row_ids: Vec<String>) -> Result<i64, String> {
    let conn = db.write_conn()?;
    let n = db::database::soft_delete_rows(&conn, &row_ids)?;
    Ok(n as i64)
}

/// 某张表的回收站内容（按删除时间倒序）
#[tauri::command]
pub async fn row_list_trash(
    db: State<'_, Db>,
    view_id: String,
) -> Result<Vec<TrashRowOut>, String> {
    let conn = db.read_conn()?;
    db::database::list_trash_rows(&conn, &view_id)
}

/// 从回收站恢复一行（行号排到末尾）
#[tauri::command]
pub async fn row_restore(db: State<'_, Db>, row_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::restore_row(&conn, &row_id)
}

/// 彻底删除一行（连同单元格与其行详情文档），不可恢复
#[tauri::command]
pub async fn row_purge(db: State<'_, Db>, row_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::purge_rows(&conn, std::slice::from_ref(&row_id))?;
    Ok(())
}

/// 清空某张表的回收站
#[tauri::command]
pub async fn row_purge_trash(db: State<'_, Db>, view_id: String) -> Result<i64, String> {
    let conn = db.write_conn()?;
    let n = db::database::purge_trash_rows(&conn, &view_id)?;
    Ok(n as i64)
}

/// 超过保留期的行彻底删除（与页面回收站共用同一个小时级清理定时器）
#[tauri::command]
pub async fn row_purge_expired_trash(db: State<'_, Db>, deadline_ms: i64) -> Result<i64, String> {
    let conn = db.write_conn()?;
    let n = db::database::purge_expired_trash_rows(&conn, deadline_ms)?;
    Ok(n as i64)
}

#[tauri::command]
pub async fn row_reorder(
    db: State<'_, Db>,
    view_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    let ids: Vec<&str> = ordered_ids.iter().map(String::as_str).collect();
    db::database::reorder_rows(&conn, &view_id, &ids)
}

#[tauri::command]
pub async fn cells_load(db: State<'_, Db>, view_id: String) -> Result<Vec<CellLoadRow>, String> {
    let conn = db.read_conn()?;
    db::database::load_cells(&conn, &view_id)
}

#[tauri::command]
pub async fn cell_set(
    db: State<'_, Db>,
    row_id: String,
    field_id: String,
    value: String,
) -> Result<(), String> {
    // value 为 JS 侧 serializeValue 产出的 JSON 字符串
    let conn = db.write_conn()?;
    db::database::set_cell(&conn, &row_id, &field_id, &value)
}

/// 批量写单元格（TSV 粘贴）：一次 IPC 一个事务，替代逐格 cell_set 循环。
#[tauri::command]
pub async fn cell_set_many(db: State<'_, Db>, updates: Vec<CellSetIn>) -> Result<i64, String> {
    let conn = db.write_conn()?;
    let n = db::database::set_cells_many(&conn, &updates)?;
    Ok(n as i64)
}

/// 批量建行（TSV 粘贴补行）：一次 IPC 一个事务。
#[tauri::command]
pub async fn row_create_many(
    db: State<'_, Db>,
    view_id: String,
    ids: Vec<String>,
) -> Result<Vec<DatabaseRowRow>, String> {
    let conn = db.write_conn()?;
    db::database::create_rows(&conn, &view_id, &ids)
}

#[tauri::command]
pub async fn csv_import(
    db: State<'_, Db>,
    view_id: String,
    fields: Vec<CsvFieldIn>,
    rows: Vec<CsvRowIn>,
) -> Result<i64, String> {
    // 返回落库单元格数；CSV 解析/类型推断/重名消歧/id 生成全在 JS 侧
    let conn = db.write_conn()?;
    let (_, _, cells) = db::database::csv_import(&conn, &view_id, &fields, &rows)?;
    Ok(cells as i64)
}
