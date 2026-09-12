//! 持久层领域命令：workspaces / views / settings / documents / mentions / search / page-properties / database。
//!
//! Tauri 2 参数契约：顶层参数 camelCase（JS）↔ snake_case（Rust），
//! 如 invoke("view_move", { viewId, newParentId, index }) → view_id / new_parent_id / index。
//! 例外：嵌套 payload（如 mention_rebuild 的 rows 数组元素）按结构体声明的 snake_case
//! 字段名反序列化，JS 调用点必须传 snake_case 键。
//! 所有命令为 async + State<'_, Db>（Tauri 要求此组合返回 Result），
//! 函数体内无 .await，Mutex guard 不跨 await。

use tauri::State;

use crate::db::{
    self, BacklinkRow, CellLoadRow, CsvFieldIn, CsvRowIn, DatabaseFieldRow, DatabaseRowRow, Db,
    DocRowOut, MentionRowIn, PagePropertyOut, SearchRowOut, ViewRow, WorkspaceRow,
};

// ---------- workspace ----------

#[tauri::command]
pub async fn workspace_list(db: State<'_, Db>) -> Result<Vec<WorkspaceRow>, String> {
    let conn = db.read_conn()?;
    db::workspaces::list(&conn)
}

#[tauri::command]
pub async fn workspace_create(db: State<'_, Db>, id: String, name: String) -> Result<WorkspaceRow, String> {
    // id 由前端 newId() 生成后传入
    let conn = db.write_conn()?;
    db::workspaces::create(&conn, &id, &name)
}

#[tauri::command]
pub async fn workspace_rename(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::workspaces::rename(&conn, &id, &name)
}

#[tauri::command]
pub async fn workspace_set_icon(db: State<'_, Db>, id: String, icon: Option<String>) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::workspaces::set_icon(&conn, &id, icon.as_deref())
}

#[tauri::command]
pub async fn workspace_remove(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::workspaces::remove(&conn, &id)
}

// ---------- view ----------

#[tauri::command]
pub async fn view_list_by_workspace(db: State<'_, Db>, workspace_id: String) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_by_workspace(&conn, &workspace_id)
}

#[tauri::command]
pub async fn view_list_trash(db: State<'_, Db>, workspace_id: String) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_trash(&conn, &workspace_id)
}

#[tauri::command]
pub async fn view_list_recent(db: State<'_, Db>, workspace_id: String, limit: i64) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_recent(&conn, &workspace_id, limit)
}

#[tauri::command]
pub async fn view_touch_visited(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::touch_visited(&conn, &id)
}

#[tauri::command]
pub async fn view_create(
    db: State<'_, Db>,
    id: String,
    workspace_id: String,
    parent_id: Option<String>,
    name: String,
    layout: String,
    extra: Option<String>,
) -> Result<ViewRow, String> {
    let conn = db.write_conn()?;
    db::views::create(
        &conn,
        &id, // 前端 newId() 生成
        &workspace_id,
        parent_id.as_deref(),
        &name,
        &layout,
        extra.as_deref().unwrap_or("{}"),
    )
}

#[tauri::command]
pub async fn view_get(db: State<'_, Db>, id: String) -> Result<Option<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::get(&conn, &id)
}

#[tauri::command]
pub async fn view_rename(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::rename(&conn, &id, &name)
}

#[tauri::command]
pub async fn view_set_icon(db: State<'_, Db>, id: String, icon: Option<String>) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::set_icon(&conn, &id, icon.as_deref())
}

#[tauri::command]
pub async fn view_soft_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::soft_delete(&conn, &id)
}

#[tauri::command]
pub async fn view_restore(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::restore(&conn, &id)
}

#[tauri::command]
pub async fn view_purge(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::purge(&conn, &id)
}

#[tauri::command]
pub async fn view_purge_trash(db: State<'_, Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::purge_trash(&conn, &workspace_id)
}

#[tauri::command]
pub async fn view_purge_expired_trash(
    db: State<'_, Db>,
    workspace_id: String,
    deadline_ms: i64,
) -> Result<i64, String> {
    let conn = db.write_conn()?;
    db::views::purge_expired_trash(&conn, &workspace_id, deadline_ms)
}

#[tauri::command]
pub async fn view_move(
    db: State<'_, Db>,
    view_id: String,
    new_parent_id: Option<String>,
    index: i64,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::move_view(&conn, &view_id, new_parent_id.as_deref(), index)
}

// ---------- app_settings ----------

#[tauri::command]
pub async fn setting_get(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.read_conn()?;
    db::settings::get(&conn, &key)
}

#[tauri::command]
pub async fn setting_set(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::settings::set(&conn, &key, &value)
}

// ---------- document ----------

#[tauri::command]
pub async fn doc_get(db: State<'_, Db>, view_id: String) -> Result<Option<String>, String> {
    let conn = db.read_conn()?;
    db::docs::get(&conn, &view_id)
}

#[tauri::command]
pub async fn doc_save(db: State<'_, Db>, view_id: String, content: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::docs::save(&conn, &view_id, &content)
}

#[tauri::command]
pub async fn doc_list_all(db: State<'_, Db>) -> Result<Vec<DocRowOut>, String> {
    let conn = db.read_conn()?;
    db::docs::list_all(&conn)
}

// ---------- mentions ----------

#[tauri::command]
pub async fn mention_rebuild(
    db: State<'_, Db>,
    view_id: String,
    rows: Vec<MentionRowIn>,
) -> Result<(), String> {
    // rows 元素按 MentionRowIn 声明的 snake_case 字段反序列化；自引用过滤在 JS 侧
    let conn = db.write_conn()?;
    db::mentions::rebuild_for(&conn, &view_id, &rows)
}

#[tauri::command]
pub async fn mention_list_backlinks(
    db: State<'_, Db>,
    target_view_id: String,
) -> Result<Vec<BacklinkRow>, String> {
    let conn = db.read_conn()?;
    db::mentions::list_backlinks(&conn, &target_view_id)
}

#[tauri::command]
pub async fn mention_count(db: State<'_, Db>) -> Result<i64, String> {
    let conn = db.read_conn()?;
    db::mentions::count(&conn)
}

// ---------- search ----------

#[tauri::command]
pub async fn search(
    db: State<'_, Db>,
    workspace_id: String,
    query: String,
) -> Result<Vec<SearchRowOut>, String> {
    // FTS 转义（escapeFts/likePattern）已下沉 Rust；标题分层排序与 <em> 清洗仍在 JS
    let conn = db.read_conn()?;
    db::search::search(&conn, &workspace_id, &query)
}

// ---------- page_properties ----------

#[tauri::command]
pub async fn pp_list(db: State<'_, Db>, view_id: String) -> Result<Vec<PagePropertyOut>, String> {
    let conn = db.read_conn()?;
    db::properties::list(&conn, &view_id)
}

#[tauri::command]
pub async fn pp_set(
    db: State<'_, Db>,
    view_id: String,
    key: String,
    value: String,
    field_type: String,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::properties::set(&conn, &view_id, &key, &value, &field_type)
}

#[tauri::command]
pub async fn pp_remove(db: State<'_, Db>, view_id: String, key: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::properties::remove(&conn, &view_id, &key)
}

#[tauri::command]
pub async fn pp_rename(
    db: State<'_, Db>,
    view_id: String,
    old_key: String,
    new_key: String,
) -> Result<(), String> {
    // 空白/同名校验在 JS 侧（pagePropertiesApi.rename 入口守卫）
    let conn = db.write_conn()?;
    db::properties::rename(&conn, &view_id, &old_key, &new_key)
}

// ---------- database（grid/board 表格三表：fields / rows / cells） ----------

#[tauri::command]
pub async fn field_list(db: State<'_, Db>, view_id: String) -> Result<Vec<DatabaseFieldRow>, String> {
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
    let conn = db.write_conn()?;
    db::database::create_field(&conn, &view_id, &id, &field_type, name.as_deref())
}

#[tauri::command]
pub async fn field_rename(db: State<'_, Db>, field_id: String, name: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::rename_field(&conn, &field_id, &name)
}

#[tauri::command]
pub async fn field_delete(db: State<'_, Db>, field_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::delete_field(&conn, &field_id)
}

#[tauri::command]
pub async fn field_set_width(db: State<'_, Db>, field_id: String, width: i64) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::set_field_width(&conn, &field_id, width)
}

#[tauri::command]
pub async fn field_set_hidden(db: State<'_, Db>, field_id: String, hidden: bool) -> Result<(), String> {
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

#[tauri::command]
pub async fn field_change_type(
    db: State<'_, Db>,
    field_id: String,
    new_type: String,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::change_field_type(&conn, &field_id, &new_type)
}

#[tauri::command]
pub async fn row_list(db: State<'_, Db>, view_id: String) -> Result<Vec<DatabaseRowRow>, String> {
    let conn = db.read_conn()?;
    db::database::list_rows(&conn, &view_id)
}

#[tauri::command]
pub async fn row_create(db: State<'_, Db>, view_id: String, id: String) -> Result<DatabaseRowRow, String> {
    // id 由前端 newId() 生成
    let conn = db.write_conn()?;
    db::database::create_row(&conn, &view_id, &id)
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

#[tauri::command]
pub async fn row_delete(db: State<'_, Db>, row_id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::database::delete_row(&conn, &row_id)
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
