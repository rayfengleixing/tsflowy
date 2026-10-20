-- 025_view_aliases：页面别名（Obsidian frontmatter 的 `aliases:`）
--
-- 一个页面除了名字之外还能有几个叫法：[[旧名]]、缩写、英文名都能把它搜出来、链过去。
--
-- 为什么和 tags 一样是 views 上的 JSON 数组字符串，而不是别名关联表：
--   别名只服务「这一页还有哪些名字」，从不按别名反查一批页面（没有标签那种全库聚合清单的需求），
--   单机库里多一张两列表只是让每次读树都多一次 JOIN。009 的 tags 是同一个理由，形状也保持一致。
--
-- 为什么不塞进 views.extra：
--   extra 由前端 view-config 的会话缓存整份读改写（400ms 防抖合并），旁路写入随时会被下一次
--   patchViewConfig 拿旧缓存覆盖掉；而别名要像 tags 一样被 SQL 直接查询命中（搜索那一侧走 json_each）。
--   独立列不受 extra 的读改写影响，复制页面时也和 tags 一样显式带上。
--
-- 默认 '[]' 而不是 NULL：消费侧（parseViewAliases / 搜索的 json_each）永远拿到合法 JSON 数组，
--   不必为"这列可能是 NULL"多写一层判空。

ALTER TABLE views ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
