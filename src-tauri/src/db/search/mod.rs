use std::collections::HashSet;

use rusqlite::{params, types::ToSql, Connection};

use super::dberr;
use super::models::SearchRowOut;

// 词法解析（转义 / 切分 / MATCH 构造）在 terms.rs，各路查询与结果合并在 query.rs；
// 跨路去重是两者共用的收口，留在本文件。
mod query;
mod terms;

pub use query::*;
pub use terms::*;

/// 同一视图可能有多条命中（一张表里多个单元格、FTS 与兜底重复），保留先出现的一条。
fn dedupe_by_view(rows: Vec<SearchRowOut>) -> Vec<SearchRowOut> {
    let mut seen: HashSet<String> = HashSet::with_capacity(rows.len());
    rows.into_iter()
        .filter(|r| seen.insert(r.view_id.clone()))
        .collect()
}

#[cfg(test)]
mod tests;
