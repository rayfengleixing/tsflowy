-- AI 会话的用量与归档标记。
-- · prompt_tokens / completion_tokens：会话累计 token，用于跨会话用量统计与费用估算
-- · archived：归档位。归档的会话不进日常历史列表，但仍留在库里可搜索、可还原
-- 老数据默认 0 / 未归档，无需回填。
ALTER TABLE ai_sessions ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_sessions ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
