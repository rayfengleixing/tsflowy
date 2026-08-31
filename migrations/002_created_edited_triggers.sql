-- 002_created_edited_triggers.sql：created_at / last_edited_at 行级时间戳（说明书 7.2）
-- created_at / last_edited_at 字段的单元格值由触发器维护，前端只读。

-- 插入行时：为 created_at / last_edited_at 字段写入当前时间（UTC ISO 秒级）
CREATE TRIGGER trg_cells_row_inserted
AFTER INSERT ON database_rows
BEGIN
  INSERT INTO database_cells(row_id, field_id, value)
  SELECT new.id, f.id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM database_fields f
  WHERE f.database_view_id = new.database_view_id
    AND f.field_type IN ('created_at', 'last_edited_at')
    AND NOT EXISTS (SELECT 1 FROM database_cells c WHERE c.row_id = new.id AND c.field_id = f.id);
END;

-- 任意单元格值变化：刷新行 updated_at（毫秒）+ 更新 last_edited_at 单元格
-- 防递归：last_edited_at 的更新带"值相同则不更新"条件，第二次触发时值已相同即停止
CREATE TRIGGER trg_cells_value_changed
AFTER UPDATE OF value ON database_cells
WHEN old.value IS NOT new.value
BEGIN
  UPDATE database_rows SET updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE id = old.row_id;
  UPDATE database_cells SET value = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE row_id = old.row_id
    AND field_id IN (SELECT id FROM database_fields f WHERE f.field_type = 'last_edited_at')
    AND value IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
END;
