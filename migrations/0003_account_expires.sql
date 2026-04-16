-- 账号过期时间（NULL 表示永久）
ALTER TABLE accounts ADD COLUMN expires_at TEXT;
