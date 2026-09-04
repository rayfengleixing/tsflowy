-- 005_page_properties.sql：页面属性表（Phase 4.2 - Page Properties）
-- 与 grid/database 用的 database_fields / database_cells 表无冲突：
--   page_properties 是"文档级"元数据（文档顶部 chips），database_* 是"表格视图行"的单元格。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS page_properties (
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL DEFAULT '',                -- JSON/字符串：text='abc' / date='YYYY-MM-DD' / select='x' / multi='["a","b"]'
  field_type  TEXT NOT NULL CHECK (field_type IN ('text','date','single_select','multi_select','number','checkbox')),
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (view_id, key)
);
CREATE INDEX IF NOT EXISTS idx_page_properties_view ON page_properties(view_id);
