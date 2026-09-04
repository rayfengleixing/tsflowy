-- 003_mentions.sql：双链反链索引表（Phase 2.1）
-- 解决 EditorPage.tsx 反链扫描"N 次 DB 查询 + 递归 JSON"的性能问题：
--   保存文档时把所有 mention 节点 (src_view_id, target_view_id, context_text) 落库，
--   反链查询变成单条 SQL，O(log N)。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mentions (
  id              TEXT PRIMARY KEY,            -- uuid，前端生成
  src_view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,  -- 引用方文档 view_id
  target_view_id  TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,  -- 被引用方 view_id（mention.attrs.id）
  context_text    TEXT,                         -- mention 所在 paragraph 的前后 30 字片段
  updated_at      INTEGER NOT NULL              -- 写入时间（毫秒），用于反链列表按时间倒序
);

CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_view_id);
CREATE INDEX IF NOT EXISTS idx_mentions_src    ON mentions(src_view_id);
