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

// 快照策略要读应用配置：documents.rs 里的 `super::files::…` 靠这条绑定解析到 commands::files。
use super::files;

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

mod ai_sessions;
mod documents;
mod tables;
mod views;
mod workspace;

pub use ai_sessions::*;
pub use documents::*;
pub use tables::*;
pub use views::*;
pub use workspace::*;

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
