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
  user_id: string;
  scopes: string[];
  provider: string | null;
}

export interface UserContext {
  id: string;
  role: "admin" | "user";
  email?: string;
}

/** Random short token, 8 chars, lowercase base32-ish */
export function generateRelayToken(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // omit 0,1,l,o for legibility
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Ensure the given user has a relay_token. Returns the (possibly newly created) token. */
export async function ensureRelayToken(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare("SELECT relay_token FROM users WHERE id = ?")
    .bind(userId).first<{ relay_token: string | null }>();
  if (row?.relay_token) return row.relay_token;

  // Generate with collision retry
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateRelayToken();
    try {
      await db.prepare("UPDATE users SET relay_token = ? WHERE id = ?")
        .bind(token, userId).run();
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!/UNIQUE|constraint/i.test(msg)) throw err;
    }
  }
  throw new Error("failed to allocate relay_token after 5 attempts");
}

export const ADMIN_USER_ID = "admin";
export const ADMIN_EMAIL = "admin@local";

type AppVars = {
  apiKey?: ApiKeyContext;
  user?: UserContext;
};

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

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function legacyAdminPassword(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD'")
    .first<{ value: string }>();
  return row?.value ?? "admin";
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  role: "admin" | "user";
}

/** 用 email + 密码登录；admin@local 用户的 password_hash 缺失时回退到 ADMIN_PASSWORD setting 并完成首次落库 */
export async function login(
  email: string,
  password: string,
  env: { DB: D1Database; JWT_SECRET: string },
): Promise<{ token: string; user: UserContext } | { error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) return { error: "email and password required" };

  const user = await env.DB.prepare(
    "SELECT id, email, password_hash, role FROM users WHERE email = ?"
  ).bind(normalized).first<UserRow>();

  if (!user) return { error: "invalid credentials" };

  const hashed = await sha256Hex(password);

  if (user.password_hash) {
    if (hashed !== user.password_hash) return { error: "invalid credentials" };
  } else {
    // 兼容：admin 首次登录时仍允许用 settings.ADMIN_PASSWORD，登录成功后写入 hash
    if (user.id !== ADMIN_USER_ID) return { error: "invalid credentials" };
    const legacy = await legacyAdminPassword(env.DB);
    if (password !== legacy) return { error: "invalid credentials" };
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(hashed, user.id).run();
  }

  const ctx: UserContext = { id: user.id, role: user.role };
  const token = await signToken(
    { uid: ctx.id, role: ctx.role, exp: Date.now() + TOKEN_EXPIRY },
    env.JWT_SECRET,
  );
  return { token, user: { ...ctx, email: user.email } };
}

/** 注册新用户（开放注册） */
export async function registerUser(
  email: string,
  password: string,
  env: { DB: D1Database; JWT_SECRET: string },
): Promise<{ token: string; user: UserContext } | { error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return { error: "invalid email" };
  if (password.length < 6) return { error: "password must be at least 6 characters" };

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(normalized).first();
  if (existing) return { error: "email already registered" };

  const id = crypto.randomUUID();
  const hash = await sha256Hex(password);
  // Generate a relay_token with collision retry; loop bound is generous since the keyspace is 32^8.
  let relayToken = generateRelayToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, role, relay_token) VALUES (?, ?, ?, 'user', ?)"
      ).bind(id, normalized, hash, relayToken).run();
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/relay_token/.test(msg)) {
        relayToken = generateRelayToken();
        continue;
      }
      throw err;
    }
  }

  const ctx: UserContext = { id, role: "user" };
  const token = await signToken(
    { uid: id, role: "user", exp: Date.now() + TOKEN_EXPIRY },
    env.JWT_SECRET,
  );
  return { token, user: { ...ctx, email: normalized } };
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

interface ApiKeyRow {
  id: string;
  user_id: string;
  scopes: string;
  provider: string | null;
  expires_at: string | null;
}

async function lookupApiKey(db: D1Database, plaintext: string): Promise<ApiKeyContext | null> {
  const hash = await sha256Hex(plaintext);
  const row = await db.prepare(
    "SELECT id, user_id, scopes, provider, expires_at FROM api_keys WHERE key_hash = ?"
  ).bind(hash).first<ApiKeyRow>();

  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // 异步更新 last_used_at，不阻塞请求
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(row.id).run().catch(() => {});

  return {
    id: row.id,
    user_id: row.user_id,
    scopes: row.scopes.split(",").map((s) => s.trim()).filter(Boolean),
    provider: row.provider,
  };
}

/** Hono 中间件：验证 Authorization header（JWT 或 API key） */
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env; Variables: AppVars }>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const token = authHeader.slice(7);

    if (token.startsWith("ak_")) {
      const key = await lookupApiKey(c.env.DB, token);
      if (!key) return c.json({ error: "invalid or expired api key" }, 401);
      c.set("apiKey", key);
      // API key 也带出 owner user 上下文，便于路由统一处理
      const userRow = await c.env.DB.prepare("SELECT id, role FROM users WHERE id = ?")
        .bind(key.user_id).first<{ id: string; role: "admin" | "user" }>();
      if (!userRow) return c.json({ error: "api key user no longer exists" }, 401);
      c.set("user", userRow);
      await next();
      return;
    }

    const payload = await verifyToken(token, c.env.JWT_SECRET);
    if (!payload) {
      return c.json({ error: "invalid or expired token" }, 401);
    }
    const uid = typeof payload.uid === "string" ? payload.uid : null;
    const role = payload.role === "admin" ? "admin" : "user";
    if (!uid) return c.json({ error: "invalid token payload" }, 401);
    c.set("user", { id: uid, role });

    await next();
  };
}

/** 要求 JWT（拒绝 API key），用于 key 管理、设置等敏感操作 */
export function requireJwt() {
  return async (c: Context<{ Bindings: Env; Variables: AppVars }>, next: Next) => {
    if (c.get("apiKey")) {
      return c.json({ error: "api keys cannot access this endpoint" }, 403);
    }
    await next();
  };
}

/** 要求当前用户是 admin（用于系统级设置） */
export function requireAdmin() {
  return async (c: Context<{ Bindings: Env; Variables: AppVars }>, next: Next) => {
    if (c.get("apiKey")) {
      return c.json({ error: "api keys cannot access this endpoint" }, 403);
    }
    const user = c.get("user");
    if (!user || user.role !== "admin") {
      return c.json({ error: "admin only" }, 403);
    }
    await next();
  };
}

/** 要求 API key 拥有指定 scope 之一（若为 JWT 则直接放行） */
export function requireScope(...scopes: Scope[]) {
  return async (c: Context<{ Bindings: Env; Variables: AppVars }>, next: Next) => {
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

/** Get current user id (always set by authMiddleware) */
export function getUserId(c: Context<{ Bindings: Env; Variables: AppVars }>): string {
  const u = c.get("user");
  if (!u) throw new Error("user context missing — route is not behind authMiddleware");
  return u.id;
}
