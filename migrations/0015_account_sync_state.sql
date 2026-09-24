-- OAuth 同步状态：用于定时任务轮转调度，以及标记需要重新授权的账号
ALTER TABLE accounts ADD COLUMN last_sync_at INTEGER;               -- 最近一次同步尝试（毫秒时间戳）
ALTER TABLE accounts ADD COLUMN sync_error TEXT;                    -- 最近一次同步失败原因
ALTER TABLE accounts ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0; -- refresh token 已失效，需重新授权
CREATE INDEX IF NOT EXISTS idx_accounts_sync_queue ON accounts(needs_reauth, last_sync_at);
