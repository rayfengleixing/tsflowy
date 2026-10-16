-- 020_views_layout_list_gallery.sql：扩展 views.layout 的 CHECK 白名单，加入 'list' / 'gallery'
--
-- 背景：新增「列表（list）」与「画廊（gallery）」两种数据库视图布局，但 014 重建后的 CHECK
--       仍只允许 'document' / 'grid' / 'board' / 'calendar' / 'timeline'，
--       写入 layout='list' 会被 CHECK 拒绝。
--
-- 做法与 014 完全一致（SQLite 不能直接改 CHECK 约束，只能重建表；两个连接级 PRAGMA 必须在
-- 事务外生效，所以版本 20 也进 migrations.rs 的 OWN_TRANSACTION_VERSIONS）：
--   1) foreign_keys=OFF：DROP TABLE 在 FK 开启时会执行隐式 DELETE，经 ON DELETE CASCADE
--      把子表（documents / database_fields / database_rows / page_properties / mentions）
--      以及自引用的派生视图全部级联清空；
--   2) legacy_alter_table=ON：RENAME 默认会重解析整个 schema 以改写其它对象里的引用，
--      而此刻旧表已删、其它触发器（trg_documents_fts_* 等）仍引用这个名字，
--      重解析会直接报 "no such table: main.views"。
--
-- 列全集照 014（001 初建 + 004 visited_at + 007 source_id + 009 tags；015–019 未再给 views 加列）。

-- 挂在 views 上的触发器随 DROP TABLE 一并消失，重建表后需原样恢复
DROP TRIGGER IF EXISTS trg_views_fts_rename;
DROP TRIGGER IF EXISTS trg_snapshots_purge;

CREATE TABLE views_new (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    TEXT,                        -- 树父节点；NULL = 空间根级
  name         TEXT NOT NULL,
  icon         TEXT,
  layout       TEXT NOT NULL CHECK (layout IN ('document','grid','board','calendar','timeline','list','gallery')),
  extra        TEXT NOT NULL DEFAULT '{}',  -- JSON：封面/字体/行高/看板分组字段/日历字段等
  position     INTEGER NOT NULL DEFAULT 0,  -- 兄弟节点排序
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  is_trash     INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  visited_at   INTEGER,                     -- 最近打开时间（004）
  source_id    TEXT REFERENCES views(id) ON DELETE CASCADE, -- 派生视图宿主（007，自引用）
  tags         TEXT NOT NULL DEFAULT '[]'   -- 页面标签 JSON 数组（009）
);

INSERT INTO views_new(id, workspace_id, parent_id, name, icon, layout, extra, position,
                      is_favorite, is_trash, deleted_at, created_at, updated_at,
                      visited_at, source_id, tags)
SELECT id, workspace_id, parent_id, name, icon, layout, extra, position,
       is_favorite, is_trash, deleted_at, created_at, updated_at,
       visited_at, source_id, tags FROM views;

DROP TABLE views;

ALTER TABLE views_new RENAME TO views;

-- 重建 001 的三个索引
CREATE INDEX idx_views_workspace ON views(workspace_id);
CREATE INDEX idx_views_parent    ON views(parent_id);
CREATE INDEX idx_views_trash     ON views(is_trash);

-- 重建 006 的四个组合索引
CREATE INDEX idx_views_ws_trash_parent  ON views(workspace_id, is_trash, parent_id);
CREATE INDEX idx_views_ws_trash_updated ON views(workspace_id, is_trash, updated_at DESC);
CREATE INDEX idx_views_ws_favorite      ON views(workspace_id, is_favorite);
CREATE INDEX idx_views_ws_layout        ON views(workspace_id, layout);

-- 重建 007 的派生视图索引（partial）
CREATE INDEX idx_views_source_id
  ON views(source_id, position)
  WHERE source_id IS NOT NULL;

-- 重建挂在 views 上的两个触发器
CREATE TRIGGER trg_views_fts_rename AFTER UPDATE OF name ON views BEGIN
  UPDATE documents_fts SET title = new.name WHERE view_id = new.id;
END;

CREATE TRIGGER trg_snapshots_purge AFTER DELETE ON views BEGIN
  DELETE FROM document_snapshots WHERE view_id = old.id;
END;
