import type { Account } from "../types";
import type { OAuthCredentials } from "../settings";
import { ReauthRequiredError, isReauthErrorCode } from "../errors";

const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

/** 生成 Gmail OAuth 授权链接 */
export function getGmailAuthUrl(creds: OAuthCredentials, origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: creds.gmailClientId,
    redirect_uri: `${origin}/api/oauth/gmail/callback`,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GMAIL_AUTH_URL}?${params}`;
}

/** 用 authorization code 换取 token，并创建 account（归到指定 user） */
export async function handleGmailCallback(
  code: string,
  creds: OAuthCredentials,
  origin: string,
  db: D1Database,
  userId: string,
): Promise<Account> {
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

  // Cross-user collision guard: accounts.email is globally UNIQUE
  const existing = await db.prepare("SELECT id, user_id FROM accounts WHERE email = ?")
    .bind(profile.emailAddress)
    .first<{ id: string; user_id: string }>();
  if (existing && existing.user_id !== userId) {
    throw new Error(`The mailbox ${profile.emailAddress} is already connected by another user`);
  }

  const id = existing?.id ?? crypto.randomUUID();
  const expiresAt = Date.now() + token.expires_in * 1000;

  await db.prepare(
    `INSERT INTO accounts (id, user_id, provider, email, access_token, refresh_token, token_expires_at, last_sync_history_id)
     VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET access_token=?, refresh_token=?, token_expires_at=?, last_sync_history_id=?, needs_reauth=0, sync_error=NULL, last_sync_at=NULL, updated_at=datetime('now')`
  )
    .bind(
      id, userId, profile.emailAddress,
      token.access_token, token.refresh_token, expiresAt, profile.historyId,
      token.access_token, token.refresh_token, expiresAt, profile.historyId
    )
    .run();

  return {
    id,
    user_id: userId,
    provider: "gmail",
    email: profile.emailAddress,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_expires_at: expiresAt,
    last_sync_history_id: profile.historyId,
    password: null,
    client_id: null,
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
  if (!account.refresh_token) throw new Error("No refresh_token available for this account.");

  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.gmailClientId,
      client_secret: creds.gmailClientSecret,
      refresh_token: account.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const token = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!token.access_token) {
    const message = token.error_description || token.error || `Failed to refresh token (HTTP ${res.status})`;
    if (isReauthErrorCode(token.error)) throw new ReauthRequiredError(message);
    throw new Error(message);
  }
  const expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;

  await db.prepare(
    "UPDATE accounts SET access_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(token.access_token, expiresAt, account.id)
    .run();

  return token.access_token;
}

/** 拉取 Gmail 新邮件 */
export async function syncGmailEmails(account: Account & { user_id: string }, creds: OAuthCredentials, db: D1Database): Promise<number> {
  const accessToken = await refreshGmailToken(account, creds, db);

  const listRes = await fetch(`${GMAIL_API}/messages?maxResults=10`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const list = (await listRes.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!listRes.ok) {
    throw new Error(`Gmail API ${listRes.status}: ${list.error?.message || "request failed"}`);
  }
  const messages = list.messages ?? [];
  if (messages.length === 0) return 0;

  const ids = messages.map((m) => m.id);
  const existing = await db.prepare(
    `SELECT message_id FROM emails WHERE account_id = ? AND message_id IN (${ids.map(() => "?").join(",")})`
  )
    .bind(account.id, ...ids)
    .all<{ message_id: string }>();
  const seen = new Set(existing.results.map((r) => r.message_id));

  const inserts: D1PreparedStatement[] = [];
  for (const msg of messages) {
    if (seen.has(msg.id)) continue;

    const detailRes = await fetch(`${GMAIL_API}/messages/${msg.id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as GmailMessage;

    const headers = Object.fromEntries(
      (detail.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );

    const textBody = extractGmailBody(detail.payload, "text/plain");
    const htmlBody = extractGmailBody(detail.payload, "text/html");

    inserts.push(db.prepare(
      `INSERT OR IGNORE INTO emails (id, user_id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
       VALUES (?, ?, ?, ?, 'gmail', ?, ?, ?, ?, ?, ?, datetime(? / 1000, 'unixepoch'))`
    ).bind(
      crypto.randomUUID(),
      account.user_id,
      account.id,
      msg.id,
      headers["from"] ?? "",
      headers["to"] ?? account.email,
      headers["subject"] ?? "",
      textBody,
      htmlBody,
      JSON.stringify(headers),
      parseInt(detail.internalDate ?? "0")
    ));
  }

  if (inserts.length > 0) await db.batch(inserts);
  return inserts.length;
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
