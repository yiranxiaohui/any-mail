-- 邮件全文搜索：FTS5 外部内容表 + 触发器同步
-- trigram 分词器支持子串匹配，且对中文（CJK）友好；查询词 <3 字符时后端回退 LIKE
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, from_address, to_address, text_body,
  content='emails', content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS emails_fts_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, from_address, to_address, text_body)
  VALUES (new.rowid, new.subject, new.from_address, new.to_address, new.text_body);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_address, to_address, text_body)
  VALUES ('delete', old.rowid, old.subject, old.from_address, old.to_address, old.text_body);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_address, to_address, text_body)
  VALUES ('delete', old.rowid, old.subject, old.from_address, old.to_address, old.text_body);
  INSERT INTO emails_fts(rowid, subject, from_address, to_address, text_body)
  VALUES (new.rowid, new.subject, new.from_address, new.to_address, new.text_body);
END;

-- 回填存量邮件
INSERT INTO emails_fts(rowid, subject, from_address, to_address, text_body)
SELECT rowid, subject, from_address, to_address, text_body FROM emails;
