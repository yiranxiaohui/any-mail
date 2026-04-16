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
  return request<{ emails: Email[]; meta: { limit: number; offset: number } }>(
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
export function getAccounts() {
  return request<{ accounts: Account[] }>("/api/accounts");
}

export function createDomainAccount(email: string, expiresAt?: string | null) {
  return request<{ ok: boolean; account: Account }>("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, expires_at: expiresAt ?? null }),
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
export const gmailAuthUrl = `${BASE}/api/oauth/gmail`;
export const outlookAuthUrl = `${BASE}/api/oauth/outlook`;
