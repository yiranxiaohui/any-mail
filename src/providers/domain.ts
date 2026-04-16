import PostalMime from "postal-mime";
import type { Env } from "../types";

export async function handleDomainEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const rawBytes = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBytes);

  const id = crypto.randomUUID();
  const toAddress = message.to;
  const fromAddress = message.from;

  // 确保 domain 类型的 account 存在且未过期
  const accountId = await ensureDomainAccount(env.DB, toAddress);
  if (!accountId) return; // 已过期，丢弃邮件

  await env.DB.prepare(
    `INSERT OR IGNORE INTO emails (id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
     VALUES (?, ?, ?, 'domain', ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      id,
      accountId,
      parsed.messageId ?? null,
      fromAddress,
      toAddress,
      parsed.subject ?? "",
      parsed.text ?? "",
      parsed.html ?? "",
      JSON.stringify(Object.fromEntries(parsed.headers.map((h) => [h.key, h.value])))
    )
    .run();
}

async function ensureDomainAccount(db: D1Database, email: string): Promise<string | null> {
  const existing = await db
    .prepare("SELECT id, expires_at FROM accounts WHERE email = ? AND provider = 'domain'")
    .bind(email)
    .first<{ id: string; expires_at: string | null }>();

  if (existing) {
    // 已过期则拒收
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      return null;
    }
    return existing.id;
  }

  // 未预创建的地址，自动创建（永久）
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO accounts (id, provider, email) VALUES (?, 'domain', ?)")
    .bind(id, email)
    .run();
  return id;
}
