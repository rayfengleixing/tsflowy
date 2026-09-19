-- 009_tags_and_snapshots：页面标签 + 文档历史快照
--
-- 标签：本地单机应用，标签直接挂 views 行上（JSON 数组字符串），不做多表关联。
--   前端聚合出全库标签清单；过滤/着色都在内存完成，SQLite 只存字符串。
--
-- 快照：doc_save 侧定时写入（每 view 间隔快照 + 上限裁剪，见 db/snapshots.rs），
--   恢复走 db::docs::save 同一条 UPSERT，FTS 由既有 trg_documents_fts_* 触发器自动同步。
--   页面被 purge 时（软删不删快照，可恢复）触发器清理该页全部快照。

ALTER TABLE views ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

CREATE TABLE document_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  view_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_snapshots_view ON document_snapshots(view_id, id);

CREATE TRIGGER trg_snapshots_purge AFTER DELETE ON views BEGIN
  DELETE FROM document_snapshots WHERE view_id = old.id;
END;
