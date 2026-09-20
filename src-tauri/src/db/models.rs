use serde::{Deserialize, Serialize};

// 行结构体字段名 == SQL 列名（snake_case，不加 rename_all）：
// 前端 stores 直接消费列名（如 `is_trash === 0` 整数比较、`parent_id`、`extra` JSON 字符串），
// 行形状必须与 tauri-plugin-sql 时代的查询结果逐字节一致。
//
// 嵌套 payload 结构体（如 MentionRowIn）按声明的 snake_case 字段名反序列化——
// JS 调用点必须传 snake_case 键（见 mentions.ts rebuildFor 的注释）。

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewRow {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub layout: String,
    pub extra: String,
    pub position: i64,
    pub is_favorite: i64,
    pub is_trash: i64,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub visited_at: Option<i64>,
    /// 多视图：Some = 宿主视图（同一张表的数据归属方）id；None = 树里的页面/宿主本身
    pub source_id: Option<String>,
    /// 页面标签（JSON 数组字符串，如 `["工作","重要"]`）
    pub tags: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 行形状契约：序列化键集 == SQL 列名清单，且 0/1 列必须是整数（前端有 `is_trash === 0` 比较）
    #[test]
    fn view_row_keys_match_column_names() {
        let v = ViewRow {
            id: "v".into(),
            workspace_id: "w".into(),
            parent_id: None,
            name: "n".into(),
            icon: None,
            layout: "document".into(),
            extra: "{}".into(),
            position: 0,
            is_favorite: 0,
            is_trash: 0,
            deleted_at: None,
            created_at: 1,
            updated_at: 1,
            visited_at: None,
            source_id: None,
            tags: "[]".into(),
        };
        let obj = serde_json::to_value(&v).unwrap();
        // serde_json 的 Map 按字典序输出键：JS 侧按属性名取值，键序无关紧要，锁死键集合即可
        let mut keys: Vec<&str> = obj.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "created_at", "deleted_at", "extra", "icon", "id", "is_favorite", "is_trash",
                "layout", "name", "parent_id", "position", "source_id", "tags", "updated_at",
                "visited_at", "workspace_id"
            ]
        );
        assert_eq!(obj["is_trash"], serde_json::json!(0));
        assert_eq!(obj["is_favorite"], serde_json::json!(0));
        assert_eq!(obj["parent_id"], serde_json::Value::Null);
    }

    #[test]
    fn workspace_row_keys_match_column_names() {
        let w = WorkspaceRow {
            id: "w".into(),
            name: "n".into(),
            icon: None,
            created_at: 1,
            updated_at: 1,
        };
        let obj = serde_json::to_value(&w).unwrap();
        let mut keys: Vec<&str> = obj.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["created_at", "icon", "id", "name", "updated_at"]);
    }
}

// ---------- Phase B：documents / mentions / search / page-properties ----------

/// mention_rebuild 的入参行。JS 侧 collectMentions 采集后逐行生成 id（newId()），
/// **字段必须传 snake_case 键**（serde 按声明字段名反序列化，不做 camelCase 转换）。
#[derive(Debug, Clone, Deserialize)]
pub struct MentionRowIn {
    pub id: String,
    pub target_view_id: String,
    pub context_text: Option<String>,
}

/// 反链查询行：mentions 行 + JOIN 带出的完整来源视图（EditorPage 反链面板直接用，免 N+1 viewApi.get）。
#[derive(Debug, Clone, Serialize)]
pub struct BacklinkRow {
    pub id: String,
    pub src_view_id: String,
    pub target_view_id: String,
    pub context_text: Option<String>,
    pub updated_at: i64,
    pub src_view: ViewRow,
}

/// search 命令输出行：JS 侧再做 sanitizeSnippet + 标题分层排序（search.ts）。
#[derive(Debug, Clone, Serialize)]
pub struct SearchRowOut {
    pub view_id: String,
    pub title: String,
    pub icon: Option<String>,
    pub layout: String,
    /// 正文命中片段（含 <em> 标记）；标题 LIKE 兜底行为空串
    pub snippet: String,
    /// 命中的数据库行 id：只有单元格命中才有，用来在表格里定位/高亮那一行
    pub row_id: Option<String>,
    /// bm25 分（越小越相关）；兜底行固定 1e9
    pub rank: f64,
}

/// page_properties 行（列名 == 字段名）
#[derive(Debug, Clone, Serialize)]
pub struct PagePropertyOut {
    pub view_id: String,
    pub key: String,
    pub value: String,
    pub field_type: String,
    pub position: i64,
}

/// doc_list_all 的输出（mentions backfill 用）
#[derive(Debug, Clone, Serialize)]
pub struct DocRowOut {
    pub view_id: String,
    pub content: String,
}

// ---------- Phase C：database_fields / database_rows / database_cells ----------

/// database_fields 行（列名 == 字段名，与 tauri-plugin-sql 时代 select 行形状一致）
#[derive(Debug, Clone, Serialize)]
pub struct DatabaseFieldRow {
    pub id: String,
    pub database_view_id: String,
    pub name: String,
    pub field_type: String,
    /// JSON 字符串（前端 parseFieldOptions 解析）
    pub options: String,
    pub width: i64,
    pub is_hidden: i64,
    pub position: i64,
}

/// database_rows 行
#[derive(Debug, Clone, Serialize)]
pub struct DatabaseRowRow {
    pub id: String,
    pub database_view_id: String,
    pub position: i64,
    pub document_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// cells_load 的扁平行（JS 侧再组装成 Record<rowId, Record<fieldId, CellValue>>）
#[derive(Debug, Clone, Serialize)]
pub struct CellLoadRow {
    pub row_id: String,
    pub field_id: String,
    /// JSON 字符串（前端 deserializeValue 解析）
    pub value: String,
}

/// csv_import 入参。JS 侧完成 CSV 解析/类型推断/重名消歧/id 生成/值序列化，
/// **嵌套 payload 必须传 snake_case 键**（同 MentionRowIn 契约）。
#[derive(Debug, Clone, Deserialize)]
pub struct CsvFieldIn {
    pub id: String,
    pub name: String,
    pub field_type: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CsvCellIn {
    pub field_id: String,
    /// 已序列化的 JSON 字符串
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CsvRowIn {
    pub id: String,
    pub cells: Vec<CsvCellIn>,
}

/// cell_set_many 入参。嵌套 payload 必须传 snake_case 键（同 CsvRowIn 契约），
/// value 为 JS 侧 serializeValue 产出的 JSON 字符串。
#[derive(Debug, Clone, Deserialize)]
pub struct CellSetIn {
    pub row_id: String,
    pub field_id: String,
    pub value: String,
}
