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
    self, BacklinkRow, CellLoadRow, CellSetIn, CsvFieldIn, CsvRowIn, DatabaseFieldRow,
    DatabaseRowRow, Db, DocRowOut, MentionRowIn, PagePropertyOut, SearchRowOut, ViewRow,
    WorkspaceRow,
};

// ---------- workspace ----------

#[tauri::command]
pub async fn workspace_list(db: State<'_, Db>) -> Result<Vec<WorkspaceRow>, String> {
    let conn = db.read_conn()?;
    db::workspaces::list(&conn)
}

#[tauri::command]
pub async fn workspace_create(
    db: State<'_, Db>,
    id: String,
    name: String,
) -> Result<WorkspaceRow, String> {
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
pub async fn workspace_set_icon(
    db: State<'_, Db>,
    id: String,
    icon: Option<String>,
) -> Result<(), String> {
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
    let conn = db.write_conn()?;
    let (view, documents) = db::views::duplicate(&conn, &id, &new_id, &name)?;
    Ok(ViewDuplicateResult { view, documents })
}

#[tauri::command]
pub async fn view_rename(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
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
    db::docs::save(&conn, &view_id, &content)?;
    // 历史快照：节流后失败不影响保存本身（快照是尽力而为的保底）
    if let Err(e) = db::snapshots::maybe_snapshot(&conn, &view_id, &content) {
        tracing::warn!(error = %e, view_id = %view_id, "snapshot after save failed");
    }
    Ok(())
}

// ---------- 历史版本快照 ----------

#[tauri::command]
pub async fn doc_snapshot_list(
    db: State<'_, Db>,
    view_id: String,
) -> Result<Vec<db::snapshots::SnapshotRowOut>, String> {
    let conn = db.read_conn()?;
    db::snapshots::list(&conn, &view_id)
}

#[tauri::command]
pub async fn doc_snapshot_restore(db: State<'_, Db>, id: i64) -> Result<String, String> {
    let conn = db.write_conn()?;
    db::snapshots::restore(&conn, id)
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

// ---------- AI 会话 ----------

/// AI 会话行。messages 存整条会话消息数组的 JSON 字符串。
#[derive(serde::Serialize, serde::Deserialize)]
pub struct AiSessionRow {
    pub id: String,
    pub title: String,
    /// 会话发起时所在的页面（用于提示「这个会话是哪一页的上下文」）
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub updated_at: String,
    pub messages: String,
}

#[tauri::command]
pub async fn ai_session_list(db: State<'_, Db>) -> Result<Vec<AiSessionRow>, String> {
    let conn = db.read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, page_id, page_title, updated_at, messages
             FROM ai_sessions ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("读取 AI 会话失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AiSessionRow {
                id: r.get(0)?,
                title: r.get(1)?,
                page_id: r.get(2)?,
                page_title: r.get(3)?,
                updated_at: r.get(4)?,
                messages: r.get(5)?,
            })
        })
        .map_err(|e| format!("读取 AI 会话失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 AI 会话失败：{e}"))?;
    Ok(rows)
}

/// 整份覆盖保存：会话条数有上限、总量不大，一个事务删旧写新最简单可靠。
#[tauri::command]
pub async fn ai_session_save_all(db: State<'_, Db>, sessions: Vec<AiSessionRow>) -> Result<(), String> {
    let mut conn = db.write_conn()?;
    let tx = conn.transaction().map_err(|e| format!("保存 AI 会话失败：{e}"))?;
    tx.execute_batch("DELETE FROM ai_sessions")
        .map_err(|e| format!("保存 AI 会话失败：{e}"))?;
    for s in &sessions {
        tx.execute(
            "INSERT OR REPLACE INTO ai_sessions (id, title, page_id, page_title, updated_at, messages)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![s.id, s.title, s.page_id, s.page_title, s.updated_at, s.messages],
        )
        .map_err(|e| format!("保存 AI 会话失败：{e}"))?;
    }
    tx.commit().map_err(|e| format!("保存 AI 会话失败：{e}"))?;
    Ok(())
}

/// 单篇文档内检索与问题相关的片段，供 AI 的 @ 引用拼上下文（避免整篇硬塞后被静默截断）。
/// 命中为空时返回空数组，由前端回退到整篇截断。
#[tauri::command]
pub async fn doc_search_snippets(
    db: State<'_, Db>,
    view_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let conn = db.read_conn()?;
    db::search::search_in_view(&conn, &view_id, &query, limit.unwrap_or(8).clamp(1, 20))
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
pub async fn row_create(
    db: State<'_, Db>,
    view_id: String,
    id: String,
) -> Result<DatabaseRowRow, String> {
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

/// 批量删行（多选删除）：一次 IPC 一个事务；返回实际删除的行数。
#[tauri::command]
pub async fn row_delete_many(db: State<'_, Db>, row_ids: Vec<String>) -> Result<i64, String> {
    let conn = db.write_conn()?;
    let n = db::database::delete_rows(&conn, &row_ids)?;
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
