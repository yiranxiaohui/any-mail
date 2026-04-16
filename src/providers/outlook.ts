import type { Account } from "../types";
import type { OAuthCredentials } from "../settings";

const MS_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

const SCOPES = "openid email Mail.Read offline_access";

/** 生成 Outlook OAuth 授权链接 */
export function getOutlookAuthUrl(creds: OAuthCredentials, origin: string): string {
  const params = new URLSearchParams({
    client_id: creds.outlookClientId,
    redirect_uri: `${origin}/api/oauth/outlook/callback`,
    response_type: "code",
    scope: SCOPES,
    response_mode: "query",
  });
  return `${MS_AUTH_URL}?${params}`;
}

/** 用 authorization code 换取 token */
export async function handleOutlookCallback(code: string, creds: OAuthCredentials, origin: string, db: D1Database): Promise<Account> {
  const tokenRes = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.outlookClientId,
      client_secret: creds.outlookClientSecret,
      redirect_uri: `${origin}/api/oauth/outlook/callback`,
      grant_type: "authorization_code",
      scope: SCOPES,
    }),
  });

  const token = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // 获取用户邮箱
  const profileRes = await fetch(GRAPH_API, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const profile = (await profileRes.json()) as { mail?: string; userPrincipalName: string };
  const email = profile.mail ?? profile.userPrincipalName;

  const id = crypto.randomUUID();
  const expiresAt = Date.now() + token.expires_in * 1000;

  await db.prepare(
    `INSERT INTO accounts (id, provider, email, access_token, refresh_token, token_expires_at)
     VALUES (?, 'outlook', ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime('now')`
  )
    .bind(
      id, email,
      token.access_token, token.refresh_token, expiresAt,
      token.access_token, token.refresh_token, expiresAt
    )
    .run();

  return {
    id,
    provider: "outlook",
    email,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_expires_at: expiresAt,
    last_sync_history_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** 刷新 Outlook access token */
async function refreshOutlookToken(account: Account, creds: OAuthCredentials, db: D1Database): Promise<string> {
  if (account.token_expires_at && account.token_expires_at > Date.now() + 60_000) {
    return account.access_token!;
  }

  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.outlookClientId,
      client_secret: creds.outlookClientSecret,
      refresh_token: account.refresh_token!,
      grant_type: "refresh_token",
      scope: SCOPES,
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

/** 拉取 Outlook 新邮件 */
export async function syncOutlookEmails(account: Account, creds: OAuthCredentials, db: D1Database): Promise<number> {
  const accessToken = await refreshOutlookToken(account, creds, db);
  let synced = 0;

  const res = await fetch(
    `${GRAPH_API}/messages?$top=10&$orderby=receivedDateTime desc&$select=id,from,toRecipients,subject,body,bodyPreview,receivedDateTime,internetMessageHeaders`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const data = (await res.json()) as { value?: OutlookMessage[] };
  if (!data.value) return 0;

  for (const msg of data.value) {
    const exists = await db.prepare(
      "SELECT 1 FROM emails WHERE message_id = ? AND account_id = ?"
    )
      .bind(msg.id, account.id)
      .first();

    if (exists) continue;

    const fromAddress = msg.from?.emailAddress
      ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
      : "";
    const toAddress = (msg.toRecipients ?? [])
      .map((r) => r.emailAddress?.address)
      .filter(Boolean)
      .join(", ") || account.email;

    const isHtml = msg.body?.contentType === "html";

    await db.prepare(
      `INSERT OR IGNORE INTO emails (id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
       VALUES (?, ?, ?, 'outlook', ?, ?, ?, ?, ?, '{}', ?)`
    )
      .bind(
        crypto.randomUUID(),
        account.id,
        msg.id,
        fromAddress,
        toAddress,
        msg.subject ?? "",
        isHtml ? (msg.bodyPreview ?? "") : (msg.body?.content ?? ""),
        isHtml ? (msg.body?.content ?? "") : "",
        msg.receivedDateTime ?? new Date().toISOString()
      )
      .run();

    synced++;
  }

  return synced;
}

interface OutlookMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress?: { name: string; address: string } };
  toRecipients?: { emailAddress?: { address: string } }[];
  receivedDateTime?: string;
}
