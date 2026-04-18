import { getStoredToken } from "./auth";

const BASE = import.meta.env.VITE_API_BASE ?? "";

export interface Account {
  id: string;
  provider: "domain" | "gmail" | "outlook";
  email: string;
  expires_at: string | null;
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
  received_at: string;
}

class AuthError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    localStorage.removeItem("anymail_token");
    window.location.href = "/login";
    throw new AuthError();
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Auth
export function apiLogin(password: string) {
  return request<{ token: string }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

// Emails
export function getEmails(params?: { account_id?: string; to?: string; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params?.account_id) q.set("account_id", params.account_id);
  if (params?.to) q.set("to", params.to);
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset) q.set("offset", String(params.offset));
  const qs = q.toString();
  return request<{ emails: Email[]; meta: { limit: number; offset: number; total: number } }>(
    `/api/emails${qs ? `?${qs}` : ""}`
  );
}

export function getEmail(id: string) {
  return request<Email>(`/api/emails/${id}`);
}

export function deleteEmail(id: string) {
  return request<{ ok: boolean }>(`/api/emails/${id}`, { method: "DELETE" });
}

// Send email
export function sendEmail(data: { from: string; to: string; subject: string; text?: string; html?: string }) {
  return request<{ ok: boolean; id: string }>("/api/emails/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// Accounts
export function getAccounts(params?: { search?: string; provider?: string; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params?.search) q.set("search", params.search);
  if (params?.provider) q.set("provider", params.provider);
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset) q.set("offset", String(params.offset));
  const qs = q.toString();
  return request<{ accounts: Account[]; meta: { limit: number; offset: number; total: number } }>(
    `/api/accounts${qs ? `?${qs}` : ""}`
  );
}

export function getAccount(id: string) {
  return request<Account & { client_id?: string | null; refresh_token?: string | null }>(`/api/accounts/${id}`);
}

export function createDomainAccount(email: string, expiresAt?: string | null) {
  return request<{ ok: boolean; account: Account }>("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, expires_at: expiresAt ?? null }),
  });
}

export function importAccounts(text: string) {
  return request<{ ok: boolean; total: number; success: number; results: { email: string; status: string }[] }>("/api/accounts/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function updateAccount(id: string, data: { email?: string; password?: string | null; expires_at?: string | null; client_id?: string | null; refresh_token?: string | null }) {
  return request<{ ok: boolean }>(`/api/accounts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteAccount(id: string) {
  return request<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" });
}

// Sync
export function triggerSync() {
  return request<{ ok: boolean; results: { email: string; provider: string; synced: number; error?: string }[] }>(
    "/api/sync",
    { method: "POST" }
  );
}

// Re-auth account via ROPC (password grant)
export function reauthAccount(id: string) {
  return request<{ ok: boolean; email?: string; error?: string }>(`/api/accounts/${id}/reauth`, {
    method: "POST",
  });
}

// Sync single account
export function syncAccount(id: string) {
  return request<{ ok: boolean; email: string; provider: string; synced: number; error?: string }>(`/api/accounts/${id}/sync`, {
    method: "POST",
  });
}

// Settings
export interface SettingsValue {
  value: string;
  masked: string;
  updated_at: string;
}

export function getSettings() {
  return request<{ settings: Record<string, SettingsValue> }>("/api/settings");
}

export function updateSettings(data: Record<string, string>) {
  return request<{ ok: boolean }>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// OAuth URLs
// Domains
export function getDomains() {
  return request<{ domains: { name: string }[] }>("/api/settings/domains");
}

export function syncDomainsFromCloudflare() {
  return request<{ ok: boolean; domains: string[] }>("/api/settings/domains/sync", { method: "POST" });
}

export const gmailAuthUrl = `${BASE}/api/oauth/gmail`;
export const outlookAuthUrl = `${BASE}/api/oauth/outlook`;
export const outlookReauthUrl = (clientId: string) => `${BASE}/api/oauth/outlook/reauth?client_id=${encodeURIComponent(clientId)}`;

// API Keys
export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string;          // comma-separated on the wire
  provider: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function getApiKeys() {
  return request<{ keys: ApiKey[] }>("/api/keys");
}

export function createApiKey(data: { name: string; scopes: string[]; provider: string | null; expires_at: string | null }) {
  return request<{ ok: boolean; key: Omit<ApiKey, "last_used_at" | "created_at">; plaintext: string }>("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteApiKey(id: string) {
  return request<{ ok: boolean }>(`/api/keys/${id}`, { method: "DELETE" });
}
