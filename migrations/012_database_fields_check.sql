-- 012_database_fields_check.sql：修正 database_fields.field_type 的 CHECK 约束
--
-- 背景：001 建表时列出的允许类型漏了 formula（前端早已支持，写入时会被 CHECK 拒绝），
--       本次一并把关联能力需要的 relation / rollup 纳入白名单。
--
-- 做法：SQLite 不能直接改 CHECK 约束，只能重建表。重建需要两个连接级 PRAGMA，
--       而 PRAGMA 在事务内是 no-op，所以由迁移运行器在事务外设置（见 migrations.rs 的
--       OWN_TRANSACTION_VERSIONS / apply_one_owning_transaction）：
--   1) foreign_keys=OFF：DROP TABLE 在 FK 开启时会执行隐式 DELETE，把 database_cells
--      经 ON DELETE CASCADE 全部级联删除；
--   2) legacy_alter_table=ON：RENAME 默认会重解析整个 schema 以改写其它对象里的引用，
--      而此刻旧表已删、其它触发器（trg_cells_row_inserted 等）仍引用这个名字，
--      重解析会直接报 "no such table: main.database_fields"。
--
-- 顺序：先建新表、搬数据、再删旧表、最后改名。反过来（先改名旧表）在非 legacy 模式下
-- 会让 SQLite 把其它对象里的引用一并改写成数据库字段旧表名，埋下死引用。

-- 该触发器挂在 database_fields 上，删旧表时会被一并删除，重建表后需原样恢复（同 011）
DROP TRIGGER IF EXISTS trg_fields_fts_rebuild;

CREATE TABLE database_fields_new (
  id               TEXT PRIMARY KEY,
  database_view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  field_type       TEXT NOT NULL CHECK (field_type IN (
    'text','number','date','single_select','multi_select','checkbox',
    'url','phone','email','formula','relation','rollup','created_at','last_edited_at')),
  options  TEXT NOT NULL DEFAULT '{}',
  width    INTEGER NOT NULL DEFAULT 180,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

INSERT INTO database_fields_new(id, database_view_id, name, field_type, options, width, is_hidden, position)
SELECT id, database_view_id, name, field_type, options, width, is_hidden, position FROM database_fields;

DROP TABLE database_fields;

ALTER TABLE database_fields_new RENAME TO database_fields;

CREATE INDEX idx_fields_db_view ON database_fields(database_view_id);

CREATE TRIGGER trg_fields_fts_rebuild AFTER UPDATE OF options, field_type ON database_fields BEGIN
  UPDATE database_fts SET content =
    (SELECT txt FROM database_cell_text
      WHERE row_id = database_fts.row_id AND field_id = new.id)
  WHERE rowid IN (SELECT rowid FROM database_cells WHERE field_id = new.id);
END;