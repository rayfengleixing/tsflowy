-- 007_multi_views.sql：数据库多视图实体化（阶段 2）
--
-- 设计动机：
--   - 此前一张表（layout=grid 的 views 行）只有"一份"显示配置，extra.mode 在 grid/board/calendar
--     之间来回切，用户无法同时保留"表格 + 按状态看板 + 按日期日历"三套各自的筛选/排序
--   - 把视图本身做成行：source_id 指向同一张表的"宿主视图"（树里可见的那个页面），
--     每个派生视图带自己的 name / layout / extra / position，数据（fields/rows/cells）始终归宿主
--
-- 兼容性：
--   - ADD COLUMN 带 REFERENCES 时默认值必须为 NULL（SQLite 约束），旧行 source_id IS NULL = 宿主，
--     无需回填；派生视图对树/回收站/最近/搜索全部不可见（Rust 侧查询统一加 source_id IS NULL）
--   - ON DELETE CASCADE：彻底删除宿主（含回收站清理）时派生视图随之消失，不留孤儿配置
--   - 旧 extra 里的 mode 键随本次改造废弃（模式即 layout），一并清掉避免留下无人读取的死键
PRAGMA foreign_keys = ON;

ALTER TABLE views ADD COLUMN source_id TEXT REFERENCES views(id) ON DELETE CASCADE;

-- 派生视图按宿主取列表（view_list_for_source）与宿主级联删除走此索引；partial 索引避开 99% 的宿主行
CREATE INDEX IF NOT EXISTS idx_views_source_id
  ON views(source_id, position)
  WHERE source_id IS NOT NULL;

-- CASE 保证短路顺序：json_extract 遇到非法 JSON 会抛错，必须先由 json_valid 挡一道，
-- 否则单个脏 extra 就会让整条迁移回滚、全库不可用。
UPDATE views SET extra = json_remove(extra, '$.mode')
 WHERE CASE WHEN json_valid(extra) = 1 THEN json_extract(extra, '$.mode') IS NOT NULL ELSE 0 END;
