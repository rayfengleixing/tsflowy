//! 视图（view）数据层：CRUD、软删/恢复/彻底删除、同 workspace 内的移动与重排、子树复制。
//! 为保持 `db::views::xxx` 的对外路径不变，这里原样重导出各子模块的公开函数。

pub mod crud;
pub mod reorder;
pub mod trash;

#[cfg(test)]
mod tests;

pub use crud::{
    create, data_view_id, duplicate, get, list_by_workspace, list_for_source, list_recent,
    list_trash, rename, set_favorite, set_icon, set_tags, touch_visited, update_extra,
};
pub use reorder::move_view;
pub use trash::{purge, purge_expired_trash, purge_trash, restore, soft_delete};

// 拆分前 views.rs 顶层 import 的这些名字，测试模块经 `use super::*` 使用；这里按 test 场景补齐。
#[cfg(test)]
#[allow(unused_imports)]
use super::{models::ViewRow, now_ms};
#[cfg(test)]
#[allow(unused_imports)]
use rusqlite::{params, Connection};
