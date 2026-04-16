-- 邮箱账号表
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,          -- 'domain' | 'gmail' | 'outlook'
  email TEXT NOT NULL UNIQUE,
  access_token TEXT,               -- OAuth access token (gmail/outlook)
  refresh_token TEXT,              -- OAuth refresh token (gmail/outlook)
  token_expires_at INTEGER,        -- token 过期时间戳
  last_sync_history_id TEXT,       -- Gmail historyId / Outlook deltaLink
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 邮件表
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  message_id TEXT,                 -- 邮件 Message-ID header
  provider TEXT NOT NULL,          -- 'domain' | 'gmail' | 'outlook'
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT DEFAULT '',
  text_body TEXT DEFAULT '',
  html_body TEXT DEFAULT '',
  raw_headers TEXT DEFAULT '{}',   -- JSON: 所有 headers
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to ON emails(to_address);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
