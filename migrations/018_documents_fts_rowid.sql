-- 018_documents_fts_rowid.sql：文档索引改为按 rowid 定位（消除 UNINDEXED 列上的全表扫描）
--
-- 设计动机：
--   001/010 的触发器用 `WHERE view_id = new.view_id` 找索引行，而 view_id 在 FTS5 里是 UNINDEXED。
--   FTS5 只对 MATCH 走索引，其余 WHERE 条件一律全表扫描——每次文档保存（编辑器防抖自动保存，
--   高频）都要扫一遍全部文档索引行，库越大保存越卡。与 011 对 database_fts 的修复同因同法。
--   做法：FTS 行的 rowid 固定取 documents.rowid（documents 以 view_id 为主键，一页一行，
--   与索引行一一对应；UPSERT 冲突更新不改 rowid），触发器改为按 rowid 定位。
--
-- 兼容性：
--   - 迁移内整表重建，存量行的 rowid 映射即刻建立（不能只改触发器，否则老索引行的 rowid 对不上）
--   - 依赖 documents.rowid 稳定：VACUUM 会重写没有 INTEGER PRIMARY KEY 的表的 rowid，
--     若将来对主库执行 VACUUM（VACUUM INTO 导出不受影响），必须重建索引：
--       DELETE FROM documents_fts; + 本文件末尾那条 INSERT...SELECT
--   - view_id 列保留：search.rs 的检索/快照判断仍按 view_id 读取，只是不再作为触发器定位条件

DROP TRIGGER trg_documents_fts_insert;
DROP TRIGGER trg_documents_fts_update;
DROP TRIGGER trg_documents_fts_delete;
DROP TRIGGER trg_views_fts_rename;

-- 建映射：FTS rowid = documents.rowid
DELETE FROM documents_fts;
INSERT INTO documents_fts(rowid, view_id, title, content)
SELECT d.rowid, d.view_id, COALESCE(v.name, ''), dt.txt
FROM documents d
JOIN views v ON v.id = d.view_id
JOIN document_text dt ON dt.view_id = d.view_id;

CREATE TRIGGER trg_documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, view_id, title, content)
  SELECT new.rowid, new.view_id, COALESCE(v.name, ''), dt.txt
  FROM views v JOIN document_text dt ON dt.view_id = new.view_id
  WHERE v.id = new.view_id;
END;

CREATE TRIGGER trg_documents_fts_update AFTER UPDATE OF content ON documents BEGIN
  UPDATE documents_fts
  SET title = COALESCE((SELECT name FROM views WHERE id = new.view_id), ''),
      content = (SELECT txt FROM document_text WHERE view_id = new.view_id)
  WHERE rowid = new.rowid;
END;

CREATE TRIGGER trg_documents_fts_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.rowid;
END;

-- 视图改名时同步标题（按 documents.rowid 定位，避免 view_id 全表扫描）
CREATE TRIGGER trg_views_fts_rename AFTER UPDATE OF name ON views BEGIN
  UPDATE documents_fts SET title = new.name
  WHERE rowid = (SELECT rowid FROM documents WHERE view_id = new.id);
END;
