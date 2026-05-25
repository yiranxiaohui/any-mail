-- Multi-user support: introduce users table, scope all per-tenant resources by user_id.
-- Existing rows backfill to a default admin user (id='admin'); admin's password is lazily
-- migrated from settings.ADMIN_PASSWORD on first successful login.
--
-- Note: we intentionally keep the existing global UNIQUE(accounts.email) constraint. Domain
-- emails MUST be globally unique (one recipient = one user), and for gmail/outlook the same
-- email always represents the same external mailbox, so global uniqueness is the natural
-- constraint. Cross-user conflicts are detected and rejected in application code.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                    -- sha256 hex; NULL for the admin bootstrap until first login
  role TEXT NOT NULL DEFAULT 'user',     -- 'admin' | 'user'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (id, email, role) VALUES ('admin', 'admin@local', 'admin');

-- Resource tables: just add user_id and backfill — no table rebuild, so the emails(account_id)
-- FK stays intact.
ALTER TABLE accounts ADD COLUMN user_id TEXT;
ALTER TABLE emails ADD COLUMN user_id TEXT;
ALTER TABLE api_keys ADD COLUMN user_id TEXT;

UPDATE accounts SET user_id = 'admin' WHERE user_id IS NULL;
UPDATE emails SET user_id = 'admin' WHERE user_id IS NULL;
UPDATE api_keys SET user_id = 'admin' WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- tag_groups: 改成按用户分组（无 FK，重建安全）
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

INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at)
  SELECT 'admin', key, value, updated_at FROM settings
  WHERE key IN ('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'RESEND_API_KEY');

DELETE FROM settings WHERE key IN ('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'RESEND_API_KEY');
