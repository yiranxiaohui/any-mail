-- 账号独立的 client_id（用于导入的微软账号）
ALTER TABLE accounts ADD COLUMN client_id TEXT;
