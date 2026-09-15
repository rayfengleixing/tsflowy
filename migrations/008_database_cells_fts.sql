-- 008_database_cells_fts.sql：数据库单元格进入全文搜索（阶段 3）
--
-- 设计动机：
--   - documents_fts 只覆盖文档正文，表格里的单元格完全搜不到
--   - 单选/多选单元格存的是选项 id（opt_xxxx），标签名在 database_fields.options 里，
--     直接把 value 入索引会搜不到用户看得见的文字 → 索引前先解析成显示文本
--   - 一个单元格一条索引行，触发器实时维护；检索侧按 view_id 折叠成"一张表一个命中"
--
-- 兼容性：
--   - created_at / last_edited_at 由 002 的触发器写成裸 ISO 串（不是合法 JSON），原样入索引，
--     正好支持按日期检索；json_valid 先挡一道，脏 value 不能让写入本身失败
--   - 宿主页面被 purge 后 JOIN views 自然过滤掉残留索引行，结果不会错

-- 单元格 → 可检索文本。派生视图不带 fields/rows（迁移 007），所以 database_view_id 即宿主页面 id。
CREATE VIEW database_cell_text AS
SELECT
  r.database_view_id AS view_id,
  c.row_id           AS row_id,
  c.field_id         AS field_id,
  CASE
    WHEN json_valid(c.value) = 0 THEN COALESCE(c.value, '')
    WHEN f.field_type = 'checkbox' THEN ''
    WHEN f.field_type = 'single_select' THEN COALESCE(
      (SELECT json_extract(o.value, '$.name')
         FROM json_each(
           CASE WHEN json_valid(f.options) = 1 THEN json_extract(f.options, '$.options') END) o
        WHERE json_extract(o.value, '$.id') = json_extract(c.value, '$')),
      json_extract(c.value, '$'))
    WHEN f.field_type = 'multi_select' AND json_type(c.value) = 'array' THEN COALESCE(
      (SELECT group_concat(
                COALESCE(
                  (SELECT json_extract(o.value, '$.name')
                     FROM json_each(
                       CASE WHEN json_valid(f.options) = 1 THEN json_extract(f.options, '$.options') END) o
                    WHERE json_extract(o.value, '$.id') = j.value),
                  j.value), ' ')
         FROM json_each(c.value) j),
      '')
    ELSE COALESCE(json_extract(c.value, '$'), '')
  END AS txt
FROM database_cells c
JOIN database_fields f ON f.id = c.field_id
JOIN database_rows r ON r.id = c.row_id;

CREATE VIRTUAL TABLE database_fts USING fts5(
  view_id UNINDEXED,
  row_id  UNINDEXED,
  field_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

-- 建表在触发器之前：存量单元格先补一次索引，之后的写入由触发器接手
INSERT INTO database_fts(view_id, row_id, field_id, content)
SELECT view_id, row_id, field_id, txt FROM database_cell_text;

-- 单元格三态同步。删行/删字段/清回收站经 FK 级联删单元格，同样命中 DELETE 触发器。
CREATE TRIGGER trg_cells_fts_insert AFTER INSERT ON database_cells BEGIN
  INSERT INTO database_fts(view_id, row_id, field_id, content)
  SELECT view_id, row_id, field_id, txt FROM database_cell_text
  WHERE row_id = new.row_id AND field_id = new.field_id;
END;

CREATE TRIGGER trg_cells_fts_update AFTER UPDATE OF value ON database_cells
WHEN old.value IS NOT new.value BEGIN
  UPDATE database_fts SET content =
    (SELECT txt FROM database_cell_text WHERE row_id = new.row_id AND field_id = new.field_id)
  WHERE row_id = new.row_id AND field_id = new.field_id;
END;

CREATE TRIGGER trg_cells_fts_delete AFTER DELETE ON database_cells BEGIN
  DELETE FROM database_fts WHERE row_id = old.row_id AND field_id = old.field_id;
END;

-- 改字段类型时 Rust 侧会把整列重置为 'null'（顺带刷新索引），但改选项（改名）只动 options，
-- 索引里的选项名必须跟着重建，否则搜索结果和表格里显示的文字对不上。
CREATE TRIGGER trg_fields_fts_rebuild AFTER UPDATE OF options, field_type ON database_fields BEGIN
  UPDATE database_fts SET content =
    (SELECT txt FROM database_cell_text
      WHERE row_id = database_fts.row_id AND field_id = new.id)
  WHERE field_id = new.id;
END;
