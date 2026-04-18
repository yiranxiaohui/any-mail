import type { Context, Next } from "hono";
import type { Env } from "./types";

const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

export type Scope =
  | "emails:read"
  | "emails:send"
  | "emails:delete"
  | "accounts:read"
  | "accounts:write"
  | "domains:read"
  | "*";

export interface ApiKeyContext {
  id: string;
  scopes: string[];
  provider: string | null;
}

/** 生成 token：base64(payload).base64(signature) */
async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${signature}`;
}

/** 验证 token */
async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigBytes = Uint8Array.from(atob(signature!), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;

  const payload = JSON.parse(atob(body!)) as Record<string, unknown>;
  if (typeof payload.exp === "number" && payload.exp < Date.now()) return null;

  return payload;
}

/** 从 DB 读取管理员密码，未设置则默认 "admin" */
async function getAdminPassword(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD'")
    .first<{ value: string }>();
  return row?.value ?? "admin";
}

/** 登录：验证密码，返回 token */
export async function login(password: string, env: { DB: D1Database; JWT_SECRET: string }) {
  const adminPassword = await getAdminPassword(env.DB);
  if (password !== adminPassword) {
    return null;
  }
  const token = await signToken(
    { role: "admin", exp: Date.now() + TOKEN_EXPIRY },
    env.JWT_SECRET
  );
  return token;
}

/** 生成一把新的 API key（明文），返回 { plaintext, hash, prefix } */
export async function generateApiKey(): Promise<{ plaintext: string; hash: string; prefix: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const plaintext = `ak_${body}`;
  const hash = await sha256Hex(plaintext);
  const prefix = plaintext.slice(0, 11); // "ak_" + 8 chars
  return { plaintext, hash, prefix };
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ApiKeyRow {
  id: string;
  scopes: string;
  provider: string | null;
  expires_at: string | null;
}

async function lookupApiKey(db: D1Database, plaintext: string): Promise<ApiKeyContext | null> {
  const hash = await sha256Hex(plaintext);
  const row = await db.prepare(
    "SELECT id, scopes, provider, expires_at FROM api_keys WHERE key_hash = ?"
  ).bind(hash).first<ApiKeyRow>();

  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // 异步更新 last_used_at，不阻塞请求
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(row.id).run().catch(() => {});

  return {
    id: row.id,
    scopes: row.scopes.split(",").map((s) => s.trim()).filter(Boolean),
    provider: row.provider,
  };
}

/** Hono 中间件：验证 Authorization header（JWT 或 API key） */
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const token = authHeader.slice(7);

    if (token.startsWith("ak_")) {
      const key = await lookupApiKey(c.env.DB, token);
      if (!key) return c.json({ error: "invalid or expired api key" }, 401);
      c.set("apiKey", key);
      await next();
      return;
    }

    const payload = await verifyToken(token, c.env.JWT_SECRET);
    if (!payload) {
      return c.json({ error: "invalid or expired token" }, 401);
    }

    await next();
  };
}

/** 要求 JWT（拒绝 API key），用于 key 管理等敏感操作 */
export function requireJwt() {
  return async (c: Context<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>, next: Next) => {
    if (c.get("apiKey")) {
      return c.json({ error: "api keys cannot access this endpoint" }, 403);
    }
    await next();
  };
}

/** 要求 API key 拥有指定 scope 之一（若为 JWT 则直接放行） */
export function requireScope(...scopes: Scope[]) {
  return async (c: Context<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>, next: Next) => {
    const key = c.get("apiKey");
    if (!key) {
      await next();
      return;
    }
    if (key.scopes.includes("*")) {
      await next();
      return;
    }
    const ok = scopes.some((s) => key.scopes.includes(s));
    if (!ok) {
      return c.json({ error: `missing required scope: ${scopes.join(" or ")}` }, 403);
    }
    await next();
  };
}
