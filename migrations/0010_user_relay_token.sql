-- Per-user shared-inbox token. Used for two delivery patterns on admin's
-- SHARED_INBOX_DOMAIN:
--   1. forward target: relay-<token>@<shared> (parses original recipient from headers)
--   2. personal suffix: *-<token>@<shared> (any local-part ending in -<token> belongs to that user)
ALTER TABLE users ADD COLUMN relay_token TEXT;

-- Backfill existing admin user with a placeholder; real generation happens in app code on
-- next login or via a future regen endpoint. We can't generate random tokens in pure SQL,
-- so leave admin's token NULL and have the auth layer fill it lazily on first use.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_relay_token ON users(relay_token) WHERE relay_token IS NOT NULL;
