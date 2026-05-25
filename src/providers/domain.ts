import PostalMime from "postal-mime";
import type { Env } from "../types";

export async function handleDomainEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const toAddress = message.to.toLowerCase();

  // 多租户：地址必须有用户主动创建的账号；否则直接丢弃（不再自动创建占位账号）
  const account = await env.DB
    .prepare("SELECT id, user_id, expires_at FROM accounts WHERE email = ? AND provider = 'domain'")
    .bind(toAddress)
    .first<{ id: string; user_id: string; expires_at: string | null }>();

  if (!account) return;
  if (account.expires_at && new Date(account.expires_at) < new Date()) return;

  const rawBytes = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBytes);

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO emails (id, user_id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
     VALUES (?, ?, ?, ?, 'domain', ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      id,
      account.user_id,
      account.id,
      parsed.messageId ?? null,
      message.from,
      toAddress,
      parsed.subject ?? "",
      parsed.text ?? "",
      parsed.html ?? "",
      JSON.stringify(Object.fromEntries(parsed.headers.map((h) => [h.key, h.value])))
    )
    .run();
}
