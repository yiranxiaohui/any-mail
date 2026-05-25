-- Multi-user support: introduce users table, scope all per-tenant resources by user_id
-- All existing rows are backfilled to a default admin user (id='admin') whose password
-- will be lazily migrated from settings.ADMIN_PASSWORD on first successful login.

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                    -- sha256 hex; NULL for the admin bootstrap until first login
  role TEXT NOT NULL DEFAULT 'user',     -- 'admin' | 'user'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (id, email, role) VALUES ('admin', 'admin@local', 'admin');

-- accounts: drop global UNIQUE(email), replace with (user_id, provider, email) and a partial UNIQUE on domain emails
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT,
  client_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  last_sync_history_id TEXT,
  expires_at TEXT,
  tag TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO accounts_new (id, user_id, provider, email, password, client_id, access_token, refresh_token, token_expires_at, last_sync_history_id, expires_at, tag, created_at, updated_at)
  SELECT id, 'admin', provider, email, password, client_id, access_token, refresh_token, token_expires_at, last_sync_history_id, expires_at, tag, created_at, updated_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_accounts_tag ON accounts(tag);
-- 同一用户下，同一 provider 同一 email 唯一
CREATE UNIQUE INDEX idx_accounts_user_provider_email ON accounts(user_id, provider, email);
-- 域名邮件全局唯一（投递只能给一个 user）
CREATE UNIQUE INDEX idx_accounts_domain_email ON accounts(email) WHERE provider = 'domain';

-- emails: 加 user_id
ALTER TABLE emails ADD COLUMN user_id TEXT;
UPDATE emails SET user_id = 'admin' WHERE user_id IS NULL;
CREATE INDEX idx_emails_user ON emails(user_id);

-- api_keys: 加 user_id
ALTER TABLE api_keys ADD COLUMN user_id TEXT;
UPDATE api_keys SET user_id = 'admin' WHERE user_id IS NULL;
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- tag_groups: 按用户分组（SQLite 改 PK 必须重建表）
CREATE TABLE tag_groups_new (
  user_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, name)
);
INSERT INTO tag_groups_new (user_id, name, created_at)
  SELECT 'admin', name, created_at FROM tag_groups;
DROP TABLE tag_groups;
ALTER TABLE tag_groups_new RENAME TO tag_groups;

-- 用户级设置（Gmail/Outlook OAuth、Resend API key 等）
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- 把现有全局 OAuth/Resend 凭证迁到 admin 名下
INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at)
  SELECT 'admin', key, value, updated_at FROM settings
  WHERE key IN ('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'RESEND_API_KEY');

DELETE FROM settings WHERE key IN ('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'RESEND_API_KEY');
