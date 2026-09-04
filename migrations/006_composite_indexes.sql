-- 006_composite_indexes.sql：views 组合索引，解决 page tree / recent / favorites / open view 等高频查询的全表扫
-- Phase 4 优化 · P0 #1

-- 页面树（workspace_id + is_trash=0 + parent_id）：最常用查询
CREATE INDEX IF NOT EXISTS idx_views_ws_trash_parent
  ON views(workspace_id, is_trash, parent_id);

-- Recent Tab / DocCalendar：workspace + is_trash=0 + updated_at DESC
CREATE INDEX IF NOT EXISTS idx_views_ws_trash_updated
  ON views(workspace_id, is_trash, updated_at DESC);

-- 收藏夹列表
CREATE INDEX IF NOT EXISTS idx_views_ws_favorite
  ON views(workspace_id, is_favorite);

-- views(workspace_id, layout) ：筛选根级 document 用于 Daily Note 匹配等
CREATE INDEX IF NOT EXISTS idx_views_ws_layout
  ON views(workspace_id, layout);
