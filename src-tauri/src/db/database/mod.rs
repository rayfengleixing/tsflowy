use rusqlite::{params, Connection};

mod cells;
mod fields;
mod rows;

pub use cells::*;
pub use fields::*;
pub use rows::*;

use super::dberr;

// 数据库三表（database_fields / database_rows / database_cells）领域函数，
// 行形状与 tauri-plugin-sql 时代 select 结果逐字节一致。
// 002 迁移的两个触发器继续生效：
// - trg_cells_row_inserted：INSERT 行时为已有 created_at/last_edited_at 字段自动补单元格
// - trg_cells_value_changed：单元格值 UPDATE 且变化时刷新行 updated_at + last_edited_at
//
// 多视图（迁移 007）：一张表的数据只挂在宿主视图上，派生视图是纯显示配置。
// 因此所有以 view_id 为入参的函数先过一遍 data_view_id 折算成宿主 id 再执行；
// 返回行里的 database_view_id 是宿主 id（前端不读该列做等值比较，仅类型保留）。

/// 由 002 迁移的两个触发器维护单元格值的字段：插行写 created_at、改值刷 last_edited_at。
/// 复制视图时这几类的源单元格不搬（见 views::crud），前端也据此判定「不能在 UI 改」。
/// 取值与 contracts/field_type_contract.json 的 triggerManagedTimestampTypes 由契约测试核对。
pub const TRIGGER_MANAGED_TIMESTAMPS: [&str; 2] = ["created_at", "last_edited_at"];

/// 镜像前端 database-values.ts defaultOptionsFor：新字段/改类型写入的默认 options JSON。
/// 键序由 serde_json 字典序决定，消费方 parseFieldOptions 按键名读取，无顺序依赖。
pub fn default_options_json(field_type: &str) -> String {
    match field_type {
        // status（状态）与单选同值形态：单元格存选项 id，阶段信息在选项里由前端标注
        "single_select" | "multi_select" | "status" => {
            serde_json::json!({ "kind": "select", "options": [] }).to_string()
        }
        "number" => serde_json::json!({
            "kind": "number", "format": "decimal", "precision": 2, "currency": "CNY"
        })
        .to_string(),
        // 货币：与 number 同一 options 形态，前端展示时强制 format=currency
        "currency" => serde_json::json!({
            "kind": "number", "format": "currency", "precision": 2, "currency": "CNY"
        })
        .to_string(),
        // 评分：满星数可配（默认 5）
        "rating" => serde_json::json!({ "kind": "rating", "max": 5 }).to_string(),
        "date" => serde_json::json!({ "kind": "date", "include_time": false }).to_string(),
        // 关联：目标库（宿主数据库视图 id）由前端在字段设置里选择，先给空占位
        "relation" => serde_json::json!({ "kind": "relation", "target_view_id": "" }).to_string(),
        // 汇总：对关联行里的目标字段做聚合；三项配置都由前端在字段设置里选择
        "rollup" => serde_json::json!({
            "kind": "rollup", "relation_field_id": "", "target_field_id": "", "fn": "count"
        })
        .to_string(),
        // 反向关系：读目标库中某个 relation 字段指向本表时，展示回指本行的来源行（前端配置）
        "reverse_relation" => serde_json::json!({
            "kind": "reverse_relation", "source_view_id": "", "source_field_id": ""
        })
        .to_string(),
        // 附件：单元格存 [{name, path}] 数组，文件落 assets/；无需额外配置
        "attachment" => serde_json::json!({ "kind": "none" }).to_string(),
        _ => serde_json::json!({ "kind": "none" }).to_string(),
    }
}

/// 表名只来自调用方写死的两处字面量，不接收用户输入。
/// 行表要排掉回收站里的行：新行接在「表里可见的行」末尾，deleted 行占的旧号由恢复时重排。
fn next_position(conn: &Connection, table: &str, view_id: &str) -> Result<i64, String> {
    debug_assert!(matches!(table, "database_fields" | "database_rows"));
    let live = if table == "database_rows" {
        " AND is_trash = 0"
    } else {
        ""
    };
    conn.query_row(
        &format!(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM {table} WHERE database_view_id = ?1{live}"
        ),
        params![view_id],
        |r| r.get(0),
    )
    .map_err(dberr("next position"))
}

#[cfg(test)]
mod tests;
