-- 账号标签分组：用于把"已使用"的邮箱归到自定义分组
ALTER TABLE accounts ADD COLUMN tag TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_tag ON accounts(tag);
