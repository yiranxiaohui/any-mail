import type { Env } from "./types";

export interface OAuthCredentials {
  gmailClientId: string;
  gmailClientSecret: string;
  outlookClientId: string;
  outlookClientSecret: string;
  oauthRedirectBase: string;
}

/** 从 D1 读取设置，env 作为 fallback */
export async function getOAuthCredentials(env: Env): Promise<OAuthCredentials> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'OAUTH_REDIRECT_BASE')"
  ).all<{ key: string; value: string }>();

  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  return {
    gmailClientId: map.get("GMAIL_CLIENT_ID") ?? env.GMAIL_CLIENT_ID ?? "",
    gmailClientSecret: map.get("GMAIL_CLIENT_SECRET") ?? env.GMAIL_CLIENT_SECRET ?? "",
    outlookClientId: map.get("OUTLOOK_CLIENT_ID") ?? env.OUTLOOK_CLIENT_ID ?? "",
    outlookClientSecret: map.get("OUTLOOK_CLIENT_SECRET") ?? env.OUTLOOK_CLIENT_SECRET ?? "",
    oauthRedirectBase: map.get("OAUTH_REDIRECT_BASE") ?? env.OAUTH_REDIRECT_BASE ?? "",
  };
}
