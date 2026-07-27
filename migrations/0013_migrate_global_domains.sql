-- Migrate the admin-managed global EMAIL_DOMAINS list into per-user user_domains
-- (owned by the admin user), then drop the setting. user_domains becomes the single
-- source of truth for domain ownership. Idempotent: OR IGNORE + DELETE.
INSERT OR IGNORE INTO user_domains (user_id, domain_name)
WITH RECURSIVE split(rest, dom) AS (
  SELECT COALESCE((SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'), '') || ',', ''
  UNION ALL
  SELECT substr(rest, instr(rest, ',') + 1), substr(rest, 1, instr(rest, ',') - 1)
  FROM split WHERE rest <> ''
)
SELECT COALESCE((SELECT id FROM users WHERE role = 'admin' LIMIT 1), 'admin'), lower(trim(dom))
FROM split WHERE trim(dom) <> '';

DELETE FROM settings WHERE key = 'EMAIL_DOMAINS';
