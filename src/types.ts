export interface Env {
  DB: D1Database;
  GMAIL_CLIENT_ID?: string;      // optional: fallback if not in DB
  GMAIL_CLIENT_SECRET?: string;
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_BASE?: string;
  ADMIN_PASSWORD: string;       // 管理员密码
  JWT_SECRET: string;           // JWT 签名密钥
}

export interface Account {
  id: string;
  provider: "domain" | "gmail" | "outlook";
  email: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  last_sync_history_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Email {
  id: string;
  account_id: string;
  message_id: string | null;
  provider: string;
  from_address: string;
  to_address: string;
  subject: string;
  text_body: string;
  html_body: string;
  raw_headers: string;
  received_at: string;
  created_at: string;
}
