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

  // 确保 domain 类型的 account 存在
  const accountId = await ensureDomainAccount(env.DB, toAddress);

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

async function ensureDomainAccount(db: D1Database, email: string): Promise<string> {
  const existing = await db
    .prepare("SELECT id FROM accounts WHERE email = ? AND provider = 'domain'")
    .bind(email)
    .first<{ id: string }>();

  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO accounts (id, provider, email) VALUES (?, 'domain', ?)")
    .bind(id, email)
    .run();
  return id;
}
