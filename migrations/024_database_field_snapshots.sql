-- 024_database_field_snapshots.sql：改字段类型前给那一列留一份取值（唯一的反悔机会）
--
-- 设计动机：
--   change_field_type 的语义是「整列写 null」：文本列误选成数字列，一列手打内容当场清零。
--   类型不兼容确实没法自动映射，但被清掉的原文值得留一份，让「撤销这次改类型」能把类型和值一起还原。
--   此前只有恢复整库备份这一条退路，代价是丢掉备份之后所有的编辑。
--
-- 为什么每个字段只留最近一份（field_id 作主键）：
--   留多份就得留一个入口让用户挑（菜单/列表/时间格式化），而恢复动作真正需要的是「刚才那次改错了」。
--   一份可撤销 = 一列的原文，体积可控；多份历史在这里只是把同一个数据重复存几遍。
--   连续改类型（A→B→C）时，B 列通常是空的，写入侧遇到「全空」就不覆盖，于是 A 的那份仍然留着。
--
-- 为什么存 JSON 而不是直接留一行行记录：
--   快照是「一次读出来整列还原」的批量数据，从来不需要按 row_id 检索；按行存会让 database_cells
--   多出一张形状相同的影子表，还得防着被视图查询误读。
--
-- 为什么连 from_options 一起存：
--   改类型时 database_fields.options 也被重置成该类型的默认值（见 default_options_json）。
--   只还原值不还原定义，选类型还原回来是个没有选项的空壳，等于还原失败。
--
-- 兼容性：
--   - 新表，无回填：只在之后的改类型动作里开始产生
--   - ON DELETE CASCADE：删字段即删它的快照（cells 走的正是这条级联），不留孤儿行
--   - values_json 里只存 value <> 'null' 的单元格，空列不占位

CREATE TABLE database_field_snapshots (
  field_id     TEXT PRIMARY KEY REFERENCES database_fields(id) ON DELETE CASCADE,
  from_type    TEXT NOT NULL,
  from_options TEXT NOT NULL,
  values_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
