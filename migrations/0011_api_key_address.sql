-- Bind an API key to a specific recipient address (substring match on emails.to_address).
-- NULL = unrestricted. Combines with `provider` and any request-supplied `to` filter (intersection).
ALTER TABLE api_keys ADD COLUMN address TEXT;
