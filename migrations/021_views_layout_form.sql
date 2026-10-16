-- 021_views_layout_form.sql：扩展 views.layout 的 CHECK 白名单，加入 'form'
--
-- 背景：新增「表单（form）」数据库视图布局（一条记录占一屏、字段自上而下逐格录入），
--       020 之后的 CHECK 仍只到 'list' / 'gallery'，写入 layout='form' 会被拒绝。
--
-- 做法照 014 / 020（SQLite 不能直接改 CHECK，只能重建表；两个连接级 PRAGMA 必须在事务外
-- 生效，所以版本 21 也进 migrations.rs 的 OWN_TRANSACTION_VERSIONS）。
-- 020 未发布过，本可以并进去，但已应用过 020 的库只会记一条指纹不一致的日志、
-- 不会补上 'form'，所以宁可多一次重建，也不改已经落进别人库里的迁移。
--
-- 列全集照 020（001 初建 + 004 visited_at + 007 source_id + 009 tags；此后未再给 views 加列）。

-- 挂在 views 上的触发器随 DROP TABLE 一并消失，重建表后需原样恢复
DROP TRIGGER IF EXISTS trg_views_fts_rename;
DROP TRIGGER IF EXISTS trg_snapshots_purge;

CREATE TABLE views_new (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    TEXT,                        -- 树父节点；NULL = 空间根级
  name         TEXT NOT NULL,
  icon         TEXT,
  layout       TEXT NOT NULL CHECK (layout IN ('document','grid','board','calendar','timeline','list','gallery','form')),
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
