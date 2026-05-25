-- Per-user domain claims. Users add domains they've configured to forward via MX to the
-- shared AnyMail email worker. Domain is globally UNIQUE so only one user can own a given
-- domain (incoming mail must route to a single tenant).
CREATE TABLE IF NOT EXISTS user_domains (
  user_id TEXT NOT NULL,
  domain_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, domain_name)
);

CREATE INDEX IF NOT EXISTS idx_user_domains_user ON user_domains(user_id);
