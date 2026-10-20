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
    DatabaseRowRow, Db, DocRowOut, MatchedDocOut, MentionRowIn, PagePropertyOut, RelationPairOut,
    SearchRowOut, TrashRowOut, ViewRow, WorkspaceRow,
};

// ---------- 命令入口参数校验 ----------
// UI 入口已先行空白/同名校验；这里是持久层边界上的第二道防线：
// 老版本前端、同步重放或任何绕过 UI 的调用者，都不该把空名或超长 id/name 写进库。

/// 主键由前端 newId()（UUID，36 位）生成，Rust 派生 id 追加 `_序号` 后缀；上限 64 足够宽松
fn check_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("id 不能为空".to_string());
    }
    if id.chars().count() > 64 {
        return Err("id 过长（最多 64 字符）".to_string());
    }
    Ok(())
}

fn check_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("名称不能为空（仅空白）".to_string());
    }
    if name.chars().count() > 500 {
        return Err("名称过长（最多 500 字符）".to_string());
    }
    Ok(())
}

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
    check_id(&id)?;
    check_name(&name)?;
    let conn = db.write_conn()?;
    db::workspaces::create(&conn, &id, &name)
}

#[tauri::command]
pub async fn workspace_rename(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    check_id(&id)?;
    check_name(&name)?;
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
    /// 会话累计输入 token（017 列）。老前端不传时按 0 处理，不会因为版本差而写失败。
    #[serde(default)]
    pub prompt_tokens: i64,
    /// 会话累计输出 token
    #[serde(default)]
    pub completion_tokens: i64,
    /// 归档位：归档的会话不进日常历史列表，但仍留在库里可检索、可还原
    #[serde(default)]
    pub archived: bool,
}

#[tauri::command]
pub async fn ai_session_list(db: State<'_, Db>) -> Result<Vec<AiSessionRow>, String> {
    let conn = db.read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, page_id, page_title, updated_at, messages, prompt_tokens, completion_tokens, archived
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
                prompt_tokens: r.get(6)?,
                completion_tokens: r.get(7)?,
                archived: r.get(8)?,
            })
        })
        .map_err(|e| format!("读取 AI 会话失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 AI 会话失败：{e}"))?;
    Ok(rows)
}

/// 保存单个会话（存在则整行覆盖）。会话条数有上限、单条体量不大，
/// 按条 upsert 比「整表删了重写」可靠：并发/失败时不会把其它会话一起清掉。
#[tauri::command]
pub async fn ai_session_save(db: State<'_, Db>, session: AiSessionRow) -> Result<(), String> {
    let conn = db.write_conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO ai_sessions (id, title, page_id, page_title, updated_at, messages, prompt_tokens, completion_tokens, archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            session.id,
            session.title,
            session.page_id,
            session.page_title,
            session.updated_at,
            session.messages,
            session.prompt_tokens.max(0),
            session.completion_tokens.max(0),
            session.archived
        ],
    )
    .map_err(|e| format!("保存 AI 会话失败：{e}"))?;
    Ok(())
}

/// 全部会话的 token 累计（含当前会话在库中的那一行）。
/// 前端据此展示跨会话用量与费用估算，不必把每行的 messages 都读回来。
#[derive(serde::Serialize)]
pub struct AiUsageSummary {
    pub sessions: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[tauri::command]
pub async fn ai_usage_summary(db: State<'_, Db>) -> Result<AiUsageSummary, String> {
    let conn = db.read_conn()?;
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0) FROM ai_sessions",
        [],
        |r| {
            Ok(AiUsageSummary {
                sessions: r.get(0)?,
                prompt_tokens: r.get(1)?,
                completion_tokens: r.get(2)?,
            })
        },
    )
    .map_err(|e| format!("读取 AI 用量统计失败：{e}"))
}

/// 删除单个会话（幂等：id 不存在也返回成功）
#[tauri::command]
pub async fn ai_session_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.write_conn()?;
    conn.execute(
        "DELETE FROM ai_sessions WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| format!("删除 AI 会话失败：{e}"))?;
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

#[cfg(test)]
mod entry_checks {
    use super::{check_id, check_name};

    #[test]
    fn blank_or_oversize_id_rejected() {
        check_id("0f6c1f2e-2b48-4c30-9b6d-7c8ef2a9c1d3").unwrap(); // UUID 36 位
        check_id(&"a".repeat(64)).unwrap(); // 边界内
        assert!(check_id("").is_err());
        assert!(check_id("   ").is_err());
        assert!(check_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn blank_or_oversize_name_rejected() {
        check_name("页面").unwrap();
        check_name(&"名".repeat(500)).unwrap(); // 按字符数计，中文一个字算 1
        assert!(check_name("").is_err());
        assert!(check_name(" \u{3000}\t\n").is_err()); // 全角空格/制表符都算空白
        assert!(check_name(&"名".repeat(501)).is_err());
    }
}
