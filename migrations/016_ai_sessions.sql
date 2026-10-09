-- AI 助手会话落库：原先存在 localStorage（约 5MB 配额，长对话会写满并被迫丢弃历史）。
-- 迁到 SQLite 后不再受配额限制，也便于以后做跨设备同步。
-- messages 存整条会话消息数组的 JSON 字符串；page_id/page_title 记录会话发起时的页面，
-- 用于提示「这个会话是基于哪一页的上下文」。
CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  page_id TEXT,
  page_title TEXT,
  updated_at TEXT NOT NULL DEFAULT '',
  messages TEXT NOT NULL DEFAULT '[]'
);
