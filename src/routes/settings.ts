import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, getUserId, type ApiKeyContext, type UserContext } from "../auth";

// 系统级（仅 admin 可读写）
const SYSTEM_KEYS = [
  "ADMIN_PASSWORD",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL_WORKER",
  "SHARED_INBOX_DOMAIN",
];

// 用户级（每个用户独立）
const USER_KEYS = [
  "RESEND_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
];

const settings = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

// 所有设置接口仅限 JWT（拒绝 API key）
settings.use("*", requireJwt());

/** 获取设置：用户级 + 系统级（系统级仅 admin 看得到） */
settings.get("/", async (c) => {
  const userId = getUserId(c);
  const user = c.get("user")!;
  const result: Record<string, { value: string; masked: string; updated_at: string }> = {};

  const userRows = await c.env.DB.prepare(
    "SELECT key, value, updated_at FROM user_settings WHERE user_id = ?"
  ).bind(userId).all<{ key: string; value: string; updated_at: string }>();

  for (const row of userRows.results) {
    if (!USER_KEYS.includes(row.key)) continue;
    result[row.key] = {
      value: row.value,
      masked: maskValue(row.key, row.value),
      updated_at: row.updated_at,
    };
  }

  if (user.role === "admin") {
    const sysRows = await c.env.DB.prepare("SELECT key, value, updated_at FROM settings").all<{ key: string; value: string; updated_at: string }>();
    for (const row of sysRows.results) {
      if (!SYSTEM_KEYS.includes(row.key)) continue;
      result[row.key] = {
        value: row.value,
        masked: maskValue(row.key, row.value),
        updated_at: row.updated_at,
      };
    }
  }

  return c.json({ settings: result });
});

/** 批量更新设置 — 用户级写当前 user_settings，系统级要求 admin */
settings.put("/", async (c) => {
  const userId = getUserId(c);
  const user = c.get("user")!;
  const body = await c.req.json<Record<string, string>>();

  const stmts = [];
  for (const [key, value] of Object.entries(body)) {
    if (USER_KEYS.includes(key)) {
      stmts.push(
        c.env.DB.prepare(
          "INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(user_id, key) DO UPDATE SET value = ?, updated_at = datetime('now')"
        ).bind(userId, key, value, value)
      );
    } else if (SYSTEM_KEYS.includes(key)) {
      if (user.role !== "admin") {
        return c.json({ error: `system setting ${key} requires admin` }, 403);
      }
      stmts.push(
        c.env.DB.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
        ).bind(key, value, value)
      );
    }
  }

  if (stmts.length > 0) {
    await c.env.DB.batch(stmts);
  }

  return c.json({ ok: true });
});

function maskValue(key: string, value: string): string {
  if ((key.includes("SECRET") || key === "ADMIN_PASSWORD" || key === "RESEND_API_KEY" || key === "CLOUDFLARE_API_TOKEN") && value.length > 4) {
    return value.slice(0, 4) + "****";
  }
  return value;
}

export default settings;
