// 工作区与应用设置命令（从 db/mod.rs 原样搬入，逻辑未改）。
// 共用的入口参数校验与 crate::db 导入留在父模块，这里用 super::* 取。
use super::*;

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
