-- 023_database_rows_parent.sql：给行加「上级行」，支持父子层级（子任务 / 分组条目）
--
-- 设计动机：
--   表格视图的行是一维清单，任务表里「需求 → 子任务」这种从属关系只能靠命名前缀硬凑。
--   层级是行的结构属性而不是单元格值（它决定渲染顺序与折叠，不参与筛选/汇总/导出），
--   所以挂在 database_rows 的列上，而不是造一个 multi_select 关联字段。
--
-- 为什么 ON DELETE SET NULL 而不是 CASCADE：
--   database_cells.row_id 对 database_rows 是 ON DELETE CASCADE，父行「彻底删除」时若子行跟着级联，
--   一次误删会连坐掉一整棵子树的数据；SET NULL 让子行升为顶层，与回收站的软删语义（可恢复）不冲突。
--   软删（进回收站）本来就不动行，父行被软删时子行仍在表里 —— 前端按「父行不在可见行集合里就当顶层」
--   回落（见 src/lib/database-hierarchy.ts），不需要在删除路径上改任何 parent_id。
--
-- 兼容性：
--   - ALTER ADD COLUMN 不带默认值即 NULL：存量行全部是顶层行，无需回填
--   - SQLite 允许给已有表加带 REFERENCES 的列，条件是它的默认值为 NULL（存量行不会违反外键）
--   - 部分索引只覆盖非 NULL 行：改父级与「查某行的子行」都是按 parent_id 点查，全表行大多为 NULL，
--     建整列索引只是给每次建行多写一条无用索引项
--   - 普通 ALTER，不进 OWN_TRANSACTION_VERSIONS：迁移运行器的事务包住即可（同 019/020/021）

ALTER TABLE database_rows ADD COLUMN parent_id TEXT REFERENCES database_rows(id) ON DELETE SET NULL;

CREATE INDEX idx_rows_parent ON database_rows(parent_id) WHERE parent_id IS NOT NULL;
