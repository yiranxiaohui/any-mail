-- API keys for external program access (e.g. code-reception polling)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,        -- SHA-256 hex of the full key
  key_prefix TEXT NOT NULL,             -- first chars shown in UI (e.g. "ak_abc123")
  scopes TEXT NOT NULL DEFAULT '',      -- comma-separated: emails:read, emails:send, emails:delete, accounts:read, accounts:write, *
  provider TEXT,                        -- nullable: 'domain' | 'gmail' | 'outlook'. NULL = unrestricted
  expires_at TEXT,                      -- ISO datetime, NULL = never
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
