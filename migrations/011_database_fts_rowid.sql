-- 011_database_fts_rowid.sql：单元格索引改为按 rowid 定位（消除 UNINDEXED 列上的全表扫描）
--
-- 设计动机：
--   008 的触发器用 `WHERE row_id = ? AND field_id = ?` 找索引行，而这两列在 FTS5 里是 UNINDEXED。
--   FTS5 只对 MATCH 走索引，其余 WHERE 条件一律全表扫描——实测 2 万单元格时每次单元格更新
--   约 17ms（含其后的 UPDATE/DELETE 触发器），批量粘贴/编辑会累积成明显卡顿。
--   做法：FTS 行的 rowid 固定取 database_cells.rowid（一个单元格一行，天然一一对应），
--   触发器改为按 rowid 定位；FTS5 对 rowid 等值条件是走索引的。
--
-- 兼容性：
--   - 迁移内整表重建，存量行的 rowid 映射即刻建立（不能只改触发器，否则老索引行的 rowid 对不上）
--   - 依赖 database_cells.rowid 稳定：VACUUM 会重写没有 INTEGER PRIMARY KEY 的表的 rowid，
--     若将来执行 VACUUM（VACUUM INTO 导出不受影响），必须重建索引：
--       DELETE FROM database_fts; + 本文件末尾那条 INSERT...SELECT
--   - 宿主页面被 purge 后 JOIN views 自然过滤掉残留索引行，结果不会错（同 008）

DROP TRIGGER trg_cells_fts_insert;
DROP TRIGGER trg_cells_fts_update;
DROP TRIGGER trg_cells_fts_delete;
DROP TRIGGER trg_fields_fts_rebuild;

-- 建映射：FTS rowid = database_cells.rowid
DELETE FROM database_fts;
INSERT INTO database_fts(rowid, view_id, row_id, field_id, content)
SELECT c.rowid, t.view_id, t.row_id, t.field_id, t.txt
FROM database_cell_text t
JOIN database_cells c ON c.row_id = t.row_id AND c.field_id = t.field_id;

-- 单元格三态同步（删行/删字段/清回收站经 FK 级联删单元格，同样命中 DELETE 触发器）
CREATE TRIGGER trg_cells_fts_insert AFTER INSERT ON database_cells BEGIN
  INSERT INTO database_fts(rowid, view_id, row_id, field_id, content)
  SELECT new.rowid, view_id, row_id, field_id, txt FROM database_cell_text
  WHERE row_id = new.row_id AND field_id = new.field_id;
END;

CREATE TRIGGER trg_cells_fts_update AFTER UPDATE OF value ON database_cells
WHEN old.value IS NOT new.value BEGIN
  UPDATE database_fts SET content =
    (SELECT txt FROM database_cell_text WHERE row_id = new.row_id AND field_id = new.field_id)
  WHERE rowid = new.rowid;
END;

CREATE TRIGGER trg_cells_fts_delete AFTER DELETE ON database_cells BEGIN
  DELETE FROM database_fts WHERE rowid = old.rowid;
END;

-- 改选项名（只动 options）要重建该字段所有单元格的索引文本
CREATE TRIGGER trg_fields_fts_rebuild AFTER UPDATE OF options, field_type ON database_fields BEGIN
  UPDATE database_fts SET content =
    (SELECT txt FROM database_cell_text
      WHERE row_id = database_fts.row_id AND field_id = new.id)
  WHERE rowid IN (SELECT rowid FROM database_cells WHERE field_id = new.id);
END;
