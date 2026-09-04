-- 004_visited_at.sql：最近访问时间戳（Phase 3.2 - Recent Tab + Breadcrumb）
--
-- 设计动机：
--   - views.updated_at 仅在元数据变更（rename/icon/favorite）时刷新，不反映"用户最近打开过"
--   - 文档布局可借 documents.updated_at 间接表达"最近编辑"，但 grid/board/calendar 无对应物
--   - 引入独立的 visited_at 列：openView 时由 viewApi.touchVisited 写入，Recent Tab 按此列倒序
--
-- 兼容性：SQLite ALTER TABLE ADD COLUMN 默认 NULL，旧数据不会被列为"最近"，行为安全。
PRAGMA foreign_keys = ON;

ALTER TABLE views ADD COLUMN visited_at INTEGER;
