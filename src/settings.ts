import type { Env } from "./types";

export interface OAuthCredentials {
  gmailClientId: string;
  gmailClientSecret: string;
  outlookClientId: string;
  outlookClientSecret: string;
}

/** 从 user_settings 读取某个用户的 OAuth 凭证，未配置则回退到 env */
export async function getOAuthCredentials(env: Env, userId: string): Promise<OAuthCredentials> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM user_settings WHERE user_id = ? AND key IN ('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET')"
  ).bind(userId).all<{ key: string; value: string }>();

  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  return {
    gmailClientId: map.get("GMAIL_CLIENT_ID") ?? env.GMAIL_CLIENT_ID ?? "",
    gmailClientSecret: map.get("GMAIL_CLIENT_SECRET") ?? env.GMAIL_CLIENT_SECRET ?? "",
    outlookClientId: map.get("OUTLOOK_CLIENT_ID") ?? env.OUTLOOK_CLIENT_ID ?? "",
    outlookClientSecret: map.get("OUTLOOK_CLIENT_SECRET") ?? env.OUTLOOK_CLIENT_SECRET ?? "",
  };
}

/** 读取用户的 Resend API Key */
export async function getResendApiKey(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM user_settings WHERE user_id = ? AND key = 'RESEND_API_KEY'"
  ).bind(userId).first<{ value: string }>();
  return row?.value ?? null;
}
