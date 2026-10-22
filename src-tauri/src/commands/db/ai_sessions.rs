// AI 会话与用量统计命令（从 db/mod.rs 原样搬入，逻辑未改）。
// 共用的入口参数校验与 crate::db 导入留在父模块，这里用 super::* 取。
use super::*;

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
