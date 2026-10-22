// 文档正文、历史快照、引用（mentions）与全文检索命令（从 db/mod.rs 原样搬入，逻辑未改）。
// 共用的入口参数校验与 crate::db 导入留在父模块，这里用 super::* 取。
use super::*;

// ---------- document ----------

#[tauri::command]
pub async fn doc_get(db: State<'_, Db>, view_id: String) -> Result<Option<String>, String> {
    let conn = db.read_conn()?;
    db::docs::get(&conn, &view_id)
}

#[tauri::command]
pub async fn doc_save(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    view_id: String,
    content: String,
) -> Result<(), String> {
    let conn = db.write_conn()?;
    db::docs::save(&conn, &view_id, &content)?;
    // 历史快照：节流后失败不影响保存本身（快照是尽力而为的保底）
    let policy = super::files::load_app_config(&app).snapshot.policy();
    if let Err(e) = db::snapshots::maybe_snapshot(&conn, &view_id, &content, &policy) {
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

/// 读取单份快照正文（历史版本对比按需取，列表仍只回元数据）
#[tauri::command]
pub async fn doc_snapshot_get(db: State<'_, Db>, id: i64) -> Result<Option<String>, String> {
    let conn = db.read_conn()?;
    db::snapshots::content(&conn, id)
}

#[tauri::command]
pub async fn doc_snapshot_restore(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    id: i64,
) -> Result<String, String> {
    let conn = db.write_conn()?;
    let policy = super::files::load_app_config(&app).snapshot.policy();
    db::snapshots::restore(&conn, id, &policy)
}

#[tauri::command]
pub async fn doc_list_all(db: State<'_, Db>) -> Result<Vec<DocRowOut>, String> {
    let conn = db.read_conn()?;
    db::docs::list_all(&conn)
}

/// 全局替换候选页：正文纯文本里字面含有 needle 的视图（本空间、非回收站）。
/// 只负责圈定候选，精确匹配与改写在前端做（见 lib/text-replace.ts 与 features/search/global-replace.ts）。
#[tauri::command]
pub async fn doc_ids_matching(
    db: State<'_, Db>,
    workspace_id: String,
    needle: String,
) -> Result<Vec<MatchedDocOut>, String> {
    let conn = db.read_conn()?;
    db::docs::ids_matching(&conn, &workspace_id, &needle)
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
