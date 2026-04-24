-- 分组定义表：允许创建空分组（没有账户的分组也能持久化）
CREATE TABLE IF NOT EXISTS tag_groups (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
