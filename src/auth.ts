import type { Context, Next } from "hono";
import type { Env } from "./types";

const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

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

/** Hono 中间件：验证 Authorization header */
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const token = authHeader.slice(7);
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    if (!payload) {
      return c.json({ error: "invalid or expired token" }, 401);
    }

    await next();
  };
}
