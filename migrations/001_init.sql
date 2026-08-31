-- 001_init.sql：初始建库（对应项目说明书第 7 章 DDL）
PRAGMA foreign_keys = ON;

-- 空间
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,                          -- emoji 字符或 SVG 名，NULL=默认
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 视图树：页面/文件夹/数据库视图统一一张表
CREATE TABLE views (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    TEXT,                        -- 树父节点；NULL = 空间根级
  name         TEXT NOT NULL,
  icon         TEXT,
  layout       TEXT NOT NULL CHECK (layout IN ('document','grid','board','calendar')),
  extra        TEXT NOT NULL DEFAULT '{}',  -- JSON：封面/字体/行高/看板分组字段/日历字段等
  position     INTEGER NOT NULL DEFAULT 0,  -- 兄弟节点排序
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  is_trash     INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_views_workspace ON views(workspace_id);
CREATE INDEX idx_views_parent   ON views(parent_id);
CREATE INDEX idx_views_trash    ON views(is_trash);

-- 文档内容（TipTap JSON 整篇存储）
CREATE TABLE documents (
  view_id    TEXT PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
  updated_at INTEGER NOT NULL
);

-- 数据库字段定义（grid/board/calendar 共用）
CREATE TABLE database_fields (
  id               TEXT PRIMARY KEY,
  database_view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  field_type       TEXT NOT NULL CHECK (field_type IN (
    'text','number','date','single_select','multi_select','checkbox',
    'url','phone','email','relation','created_at','last_edited_at')),
  options  TEXT NOT NULL DEFAULT '{}',  -- JSON：数字格式/日期格式/单选多选选项/关联目标库
  width    INTEGER NOT NULL DEFAULT 180,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fields_db_view ON database_fields(database_view_id);

-- 数据库行
CREATE TABLE database_rows (
  id               TEXT PRIMARY KEY,
  database_view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL DEFAULT 0,
  document_id      TEXT,                  -- 行详情文档 view_id；NULL=未创建
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_rows_db_view ON database_rows(database_view_id);

-- 单元格值（JSON 编码，类型见第 7.2 节）
CREATE TABLE database_cells (
  row_id   TEXT NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES database_fields(id) ON DELETE CASCADE,
  value    TEXT NOT NULL DEFAULT 'null',
  PRIMARY KEY (row_id, field_id)
);

-- 应用设置（键值）
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 全文搜索（FTS5，trigram 分词支持中文子串检索）
CREATE VIRTUAL TABLE documents_fts USING fts5(
  view_id UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);

-- 同步触发器：文档内容变化 → 更新索引
CREATE TRIGGER trg_documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(view_id, title, content)
  SELECT new.view_id, COALESCE(v.name,''), new.content
  FROM views v WHERE v.id = new.view_id;
END;
CREATE TRIGGER trg_documents_fts_update AFTER UPDATE OF content ON documents BEGIN
  UPDATE documents_fts SET title = COALESCE(v.name,''), content = new.content
  FROM views v WHERE v.id = new.view_id AND documents_fts.view_id = new.view_id;
END;
CREATE TRIGGER trg_documents_fts_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE view_id = old.view_id;
END;
-- 视图改名时同步标题
CREATE TRIGGER trg_views_fts_rename AFTER UPDATE OF name ON views BEGIN
  UPDATE documents_fts SET title = new.name WHERE view_id = new.id;
END;
