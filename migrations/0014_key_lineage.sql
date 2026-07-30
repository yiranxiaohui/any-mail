-- Key lineage: track which API key created this key (NULL = created by a JWT user).
-- No FK; cascade deletion is done in application code via recursive CTE.
ALTER TABLE api_keys ADD COLUMN created_by_key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_parent ON api_keys(created_by_key_id);
