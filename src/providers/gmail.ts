import type { Env, Account } from "../types";
import type { OAuthCredentials } from "../settings";

const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

/** 生成 Gmail OAuth 授权链接 */
export function getGmailAuthUrl(creds: OAuthCredentials, origin: string): string {
  const params = new URLSearchParams({
    client_id: creds.gmailClientId,
    redirect_uri: `${origin}/api/oauth/gmail/callback`,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GMAIL_AUTH_URL}?${params}`;
}

/** 用 authorization code 换取 token，并创建 account */
export async function handleGmailCallback(code: string, creds: OAuthCredentials, origin: string, db: D1Database): Promise<Account> {
  const tokenRes = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.gmailClientId,
      client_secret: creds.gmailClientSecret,
      redirect_uri: `${origin}/api/oauth/gmail/callback`,
      grant_type: "authorization_code",
    }),
  });

  const token = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // 获取用户邮箱
  const profileRes = await fetch(`${GMAIL_API}/profile`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const profile = (await profileRes.json()) as { emailAddress: string; historyId: string };

  const id = crypto.randomUUID();
  const expiresAt = Date.now() + token.expires_in * 1000;

  await db.prepare(
    `INSERT INTO accounts (id, provider, email, access_token, refresh_token, token_expires_at, last_sync_history_id)
     VALUES (?, 'gmail', ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET access_token=?, refresh_token=?, token_expires_at=?, last_sync_history_id=?, updated_at=datetime('now')`
  )
    .bind(
      id, profile.emailAddress,
      token.access_token, token.refresh_token, expiresAt, profile.historyId,
      token.access_token, token.refresh_token, expiresAt, profile.historyId
    )
    .run();

  return {
    id,
    provider: "gmail",
    email: profile.emailAddress,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_expires_at: expiresAt,
    last_sync_history_id: profile.historyId,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** 刷新 Gmail access token */
async function refreshGmailToken(account: Account, creds: OAuthCredentials, db: D1Database): Promise<string> {
  if (account.token_expires_at && account.token_expires_at > Date.now() + 60_000) {
    return account.access_token!;
  }

  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.gmailClientId,
      client_secret: creds.gmailClientSecret,
      refresh_token: account.refresh_token!,
      grant_type: "refresh_token",
    }),
  });

  const token = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = Date.now() + token.expires_in * 1000;

  await db.prepare(
    "UPDATE accounts SET access_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(token.access_token, expiresAt, account.id)
    .run();

  return token.access_token;
}

/** 拉取 Gmail 新邮件 */
export async function syncGmailEmails(account: Account, creds: OAuthCredentials, db: D1Database): Promise<number> {
  const accessToken = await refreshGmailToken(account, creds, db);
  let synced = 0;

  const listRes = await fetch(`${GMAIL_API}/messages?maxResults=10`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const list = (await listRes.json()) as { messages?: { id: string }[] };

  if (!list.messages) return 0;

  for (const msg of list.messages) {
    const exists = await db.prepare(
      "SELECT 1 FROM emails WHERE message_id = ? AND account_id = ?"
    )
      .bind(msg.id, account.id)
      .first();

    if (exists) continue;

    const detailRes = await fetch(`${GMAIL_API}/messages/${msg.id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const detail = (await detailRes.json()) as GmailMessage;

    const headers = Object.fromEntries(
      (detail.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );

    const textBody = extractGmailBody(detail.payload, "text/plain");
    const htmlBody = extractGmailBody(detail.payload, "text/html");

    await db.prepare(
      `INSERT OR IGNORE INTO emails (id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
       VALUES (?, ?, ?, 'gmail', ?, ?, ?, ?, ?, ?, datetime(? / 1000, 'unixepoch'))`
    )
      .bind(
        crypto.randomUUID(),
        account.id,
        msg.id,
        headers["from"] ?? "",
        headers["to"] ?? account.email,
        headers["subject"] ?? "",
        textBody,
        htmlBody,
        JSON.stringify(headers),
        parseInt(detail.internalDate ?? "0")
      )
      .run();

    synced++;
  }

  return synced;
}

function extractGmailBody(
  payload: GmailMessage["payload"],
  mimeType: string
): string {
  if (!payload) return "";

  if (payload.mimeType === mimeType && payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractGmailBody(part, mimeType);
      if (result) return result;
    }
  }

  return "";
}

function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPayload;
}

interface GmailPayload {
  mimeType: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
}
