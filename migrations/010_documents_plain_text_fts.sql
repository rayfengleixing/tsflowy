-- 010_documents_plain_text_fts.sql：文档正文索引从 TipTap JSON 原文改为纯文本（搜索结果可读）
--
-- 设计动机：
--   - documents.content 存的是 TipTap JSON，001 的触发器把原文整段塞进 documents_fts.content，
--     于是 snippet() 出来的命中上下文是 `{"type":"doc","content":[{"type":"text","text":"…`
--   - 索引 JSON 还会让 `type`/`attrs` 等结构噪声参与匹配与 bm25 排序
--   - 纯文本用派生视图表达（与 008 的 database_cell_text 同构）：所有写入路径都走触发器，
--     不必让 Rust 侧每个 writer 记得同步一份文本列
--
-- 兼容性：
--   - mention 的显示名在 attrs.label（节点本身无文字），用户看得见 → 一并入索引；
--     id/viewId 等结构字段不入索引（与 008「只索引看得见的文字」一致）
--   - content 非法 JSON（历史脏数据/非 TipTap）时退回原文，保证仍能被检索到
--   - 空文档抽取结果为空串，索引行照常存在（标题命中仍走同一行）

-- 文档 → 可检索文本：json_tree 按文档顺序遍历，取 text 叶子与 label 属性
CREATE VIEW document_text AS
SELECT
  d.view_id AS view_id,
  CASE
    WHEN json_valid(d.content) = 0 THEN COALESCE(d.content, '')
    ELSE COALESCE(
      (SELECT group_concat(j.value, ' ')
         FROM json_tree(d.content) j
        WHERE j.type = 'text' AND j.key IN ('text', 'label')),
      '')
  END AS txt
FROM documents d;

-- 触发器改为索引纯文本
DROP TRIGGER trg_documents_fts_insert;
DROP TRIGGER trg_documents_fts_update;
CREATE TRIGGER trg_documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(view_id, title, content)
  SELECT new.view_id, COALESCE(v.name,''), dt.txt
  FROM views v JOIN document_text dt ON dt.view_id = new.view_id
  WHERE v.id = new.view_id;
END;
CREATE TRIGGER trg_documents_fts_update AFTER UPDATE OF content ON documents BEGIN
  UPDATE documents_fts
  SET title = COALESCE((SELECT name FROM views WHERE id = new.view_id), ''),
      content = (SELECT txt FROM document_text WHERE view_id = new.view_id)
  WHERE view_id = new.view_id;
END;

-- 存量索引里存的是 JSON 原文 → 整表重建
DELETE FROM documents_fts;
INSERT INTO documents_fts(view_id, title, content)
SELECT d.view_id, COALESCE(v.name,''), dt.txt
FROM documents d
JOIN views v ON v.id = d.view_id
JOIN document_text dt ON dt.view_id = d.view_id;
