-- 019_rows_trash.sql：数据库行进回收站（与 views 的软删约定同构）
--
-- 设计动机：
--   删行原本是硬删除（database_cells 经 FK 级联直接消失），误删一次数据只能靠整库备份回退。
--   页面侧早有 is_trash + deleted_at 的回收站约定，行沿用同一套：软删只是打标记，
--   单元格留在库里，恢复即回到表格；到保留期或被用户「彻底删除」时才真删。
--
-- 兼容性：
--   - ALTER ADD COLUMN 带 DEFAULT 0：存量行自动视为「在表格里」，不需要回填
--   - 组合索引服务两个高频查询：列视图时按 (database_view_id, is_trash) 过滤、
--     回收站按 deleted_at 排序；单列 idx_rows_db_view 保留给既有 JOIN
--   - 不进 OWN_TRANSACTION_VERSIONS：普通 ALTER 由迁移运行器的事务包住即可

ALTER TABLE database_rows ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0;
ALTER TABLE database_rows ADD COLUMN deleted_at INTEGER;

CREATE INDEX idx_rows_db_view_trash ON database_rows(database_view_id, is_trash);
CREATE INDEX idx_rows_trash_deleted ON database_rows(deleted_at) WHERE is_trash = 1;
