// 页面（views）与页面属性（page_properties）命令（从 db/mod.rs 原样搬入，逻辑未改）。
// 共用的入口参数校验与 crate::db 导入留在父模块，这里用 super::* 取。
use super::*;

// ---------- view ----------

#[tauri::command]
pub async fn view_list_by_workspace(
    db: State<'_, Db>,
    workspace_id: String,
) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_by_workspace(&conn, &workspace_id)
}

#[tauri::command]
pub async fn view_list_trash(
    db: State<'_, Db>,
    workspace_id: String,
) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_trash(&conn, &workspace_id)
}

/// 一张数据库表的全部视图（宿主 + 派生，按 position 排序）：页面内视图标签栏数据源
#[tauri::command]
pub async fn view_list_for_source(
    db: State<'_, Db>,
    source_id: String,
) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_for_source(&conn, &source_id)
}

#[tauri::command]
pub async fn view_list_recent(
    db: State<'_, Db>,
    workspace_id: String,
    limit: i64,
) -> Result<Vec<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::list_recent(&conn, &workspace_id, limit)
}

#[tauri::command]
pub async fn view_touch_visited(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::touch_visited(&conn, &id)
}

// IPC 契约：参数名即前端 invoke 的字段名，不能打包成结构体，故豁免 too_many_arguments。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn view_create(
    db: State<'_, Db>,
    id: String,
    workspace_id: String,
    parent_id: Option<String>,
    name: String,
    layout: String,
    extra: Option<String>,
    source_id: Option<String>,
) -> Result<ViewRow, String> {
    check_id(&id)?;
    check_name(&name)?;
    let conn = db.write_conn()?;
    db::views::create(
        &conn,
        db::views::NewView {
            id: &id, // 前端 newId() 生成
            workspace_id: &workspace_id,
            parent_id: parent_id.as_deref(),
            name: &name,
            layout: &layout,
            extra: extra.as_deref().unwrap_or("{}"),
            source_id: source_id.as_deref(),
        },
    )
}

#[tauri::command]
pub async fn view_get(db: State<'_, Db>, id: String) -> Result<Option<ViewRow>, String> {
    let conn = db.read_conn()?;
    db::views::get(&conn, &id)
}

/// 复制页面整棵子树：返回副本根视图 + 副本正文（前端据此重建 mentions 反链索引）。
#[derive(serde::Serialize)]
pub struct ViewDuplicateResult {
    pub view: ViewRow,
    pub documents: Vec<DocRowOut>,
}

#[tauri::command]
pub async fn view_duplicate(
    db: State<'_, Db>,
    id: String,
    new_id: String,
    name: String,
) -> Result<ViewDuplicateResult, String> {
    // new_id 由前端 newId() 生成（后代 id 在 Rust 侧派生）
    check_id(&new_id)?;
    check_name(&name)?;
    let conn = db.write_conn()?;
    let (view, documents) = db::views::duplicate(&conn, &id, &new_id, &name)?;
    Ok(ViewDuplicateResult { view, documents })
}

#[tauri::command]
pub async fn view_rename(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    check_id(&id)?;
    check_name(&name)?;
    let conn = db.write_conn()?;
    db::views::rename(&conn, &id, &name)
}

#[tauri::command]
pub async fn view_set_icon(
    db: State<'_, Db>,
    id: String,
    icon: Option<String>,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::set_icon(&conn, &id, icon.as_deref())
}

#[tauri::command]
pub async fn view_update_extra(db: State<'_, Db>, id: String, extra: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::update_extra(&conn, &id, &extra)
}

#[tauri::command]
pub async fn view_set_favorite(
    db: State<'_, Db>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::set_favorite(&conn, &id, favorite)
}

#[tauri::command]
pub async fn view_set_tags(db: State<'_, Db>, id: String, tags: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::set_tags(&conn, &id, &tags)
}

/// 页面别名（整体覆写 JSON 数组字符串，与 view_set_tags 同一形状）
#[tauri::command]
pub async fn view_set_aliases(
    db: State<'_, Db>,
    id: String,
    aliases: String,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::set_aliases(&conn, &id, &aliases)
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

/// 把页面连同子树搬到另一个空间；new_parent_id 为空表示挂到目标空间的根级。
#[tauri::command]
pub async fn view_move_to_workspace(
    db: State<'_, Db>,
    view_id: String,
    target_workspace_id: String,
    new_parent_id: Option<String>,
    index: i64,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::views::move_view_to_workspace(
        &conn,
        &view_id,
        &target_workspace_id,
        new_parent_id.as_deref(),
        index,
    )
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
