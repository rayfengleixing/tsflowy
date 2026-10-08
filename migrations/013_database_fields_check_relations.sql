-- 013_database_fields_check_relations.sql：继续扩展 database_fields.field_type 白名单
--
-- 背景：012 已经把 formula / relation / rollup 纳入 CHECK，本次新增两个前端字段类型：
--   - attachment：附件字段（多文件，单元格存 [{name,path}] JSON，文件落 assets/）
--   - reverse_relation：反向关系（只读虚拟字段，展示目标库中指向本行的来源行，不落值）
--
-- 做法与 012 完全一致（SQLite 不能直接改 CHECK，只能重建表），且必须由迁移运行器
-- 在事务外设置两个连接级 PRAGMA：
--   1) foreign_keys=OFF：DROP TABLE 在 FK 开启时会执行隐式 DELETE，把 database_cells
--      经 ON DELETE CASCADE 全部级联删除；
--   2) legacy_alter_table=ON：RENAME 默认会重解析整个 schema 以改写其它对象里的引用，
--      而此刻旧表已删、其它触发器（trg_cells_row_inserted 等）仍引用这个名字，
--      重解析会直接报 "no such table: main.database_fields"。
--
-- 顺序：先建新表、搬数据、再删旧表、最后改名。反过来（先改名旧表）在非 legacy 模式下
-- 会让 SQLite 把其它对象里的引用一并改写成数据库字段旧表名，埋下死引用。

-- 该触发器挂在 database_fields 上，删旧表时会被一并删除，重建表后需原样恢复（同 011/012）
DROP TRIGGER IF EXISTS trg_fields_fts_rebuild;

CREATE TABLE database_fields_new (
  id               TEXT PRIMARY KEY,
  database_view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  field_type       TEXT NOT NULL CHECK (field_type IN (
    'text','number','date','single_select','multi_select','checkbox',
    'url','phone','email','formula','relation','rollup','created_at','last_edited_at',
    'attachment','reverse_relation')),
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
