import PostalMime, { type Email as ParsedEmail } from "postal-mime";
import type { Env } from "../types";

const TOKEN_RE = /^[a-z0-9]{8}$/;
const SUFFIX_RE = /^(.+)-([a-z0-9]{8})$/;

export async function handleDomainEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const toAddress = message.to.toLowerCase();

  // 1) 精确匹配某个已创建的 domain 账号（用户自己的域名或 admin 全局域下预创建的地址）
  const account = await env.DB
    .prepare("SELECT id, user_id, expires_at FROM accounts WHERE email = ? AND provider = 'domain'")
    .bind(toAddress)
    .first<{ id: string; user_id: string; expires_at: string | null }>();

  if (account) {
    if (account.expires_at && new Date(account.expires_at) < new Date()) return;
    const parsed = await parseMime(message);
    await insertEmail(env, {
      userId: account.user_id,
      accountId: account.id,
      messageId: parsed.messageId ?? null,
      from: message.from,
      to: toAddress,
      subject: parsed.subject ?? "",
      text: parsed.text ?? "",
      html: parsed.html ?? "",
      headers: parsed.headers,
    });
    return;
  }

  // 2) 共享收信域名上的两种动态路由
  const sharedRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'SHARED_INBOX_DOMAIN'")
    .first<{ value: string }>();
  const sharedDomain = sharedRow?.value?.trim().toLowerCase();
  if (!sharedDomain) return; // 没配置共享域，丢

  const atIdx = toAddress.indexOf("@");
  if (atIdx <= 0) return;
  const localPart = toAddress.slice(0, atIdx);
  const domainPart = toAddress.slice(atIdx + 1);
  if (domainPart !== sharedDomain) return;

  // 2a) relay-<token>@<shared>: 中转地址，从邮件头反推原始收件人
  if (localPart.startsWith("relay-")) {
    const token = localPart.slice(6);
    if (!TOKEN_RE.test(token)) return;
    const userId = await lookupUserByToken(env, token);
    if (!userId) return;

    const parsed = await parseMime(message);
    const original = extractOriginalRecipient(parsed) ?? toAddress;
    await insertEmail(env, {
      userId,
      accountId: "",
      messageId: parsed.messageId ?? null,
      from: message.from,
      to: original.toLowerCase(),
      subject: parsed.subject ?? "",
      text: parsed.text ?? "",
      html: parsed.html ?? "",
      headers: parsed.headers,
    });
    return;
  }

  // 2b) *-<token>@<shared>: 用户的个人后缀
  const match = SUFFIX_RE.exec(localPart);
  if (!match) return;
  const token = match[2]!;
  const userId = await lookupUserByToken(env, token);
  if (!userId) return;

  const parsed = await parseMime(message);
  await insertEmail(env, {
    userId,
    accountId: "",
    messageId: parsed.messageId ?? null,
    from: message.from,
    to: toAddress,
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    html: parsed.html ?? "",
    headers: parsed.headers,
  });
}

async function parseMime(message: ForwardableEmailMessage): Promise<ParsedEmail> {
  const rawBytes = await new Response(message.raw).arrayBuffer();
  return new PostalMime().parse(rawBytes);
}

async function lookupUserByToken(env: Env, token: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE relay_token = ?")
    .bind(token).first<{ id: string }>();
  return row?.id ?? null;
}

/** 从转发邮件中尽力恢复原始收件人地址（不会百分百准确，依赖中转服务保留的头） */
function extractOriginalRecipient(parsed: ParsedEmail): string | null {
  const headerMap = new Map(parsed.headers.map((h) => [h.key.toLowerCase(), h.value]));
  for (const key of ["x-forwarded-to", "delivered-to", "x-original-to"]) {
    const v = headerMap.get(key);
    if (v) {
      const m = /<([^>]+)>/.exec(v);
      return (m?.[1] ?? v).trim();
    }
  }
  // 最后兜底用 To: 头第一个地址（可能就是中转地址本身）
  if (parsed.to && parsed.to.length > 0 && parsed.to[0]?.address) {
    return parsed.to[0].address;
  }
  return null;
}

interface EmailInsert {
  userId: string;
  accountId: string;
  messageId: string | null;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: ParsedEmail["headers"];
}

async function insertEmail(env: Env, e: EmailInsert): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO emails (id, user_id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
     VALUES (?, ?, ?, ?, 'domain', ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      id, e.userId, e.accountId, e.messageId, e.from, e.to, e.subject, e.text, e.html,
      JSON.stringify(Object.fromEntries(e.headers.map((h) => [h.key, h.value]))),
    )
    .run();
}
