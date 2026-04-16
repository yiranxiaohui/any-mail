import { Hono } from "hono";
import type { Env } from "../types";

const ALLOWED_KEYS = [
  "ADMIN_PASSWORD",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
  "OAUTH_REDIRECT_BASE",
];

const settings = new Hono<{ Bindings: Env }>();

/** 获取所有设置（敏感值脱敏） */
settings.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value, updated_at FROM settings")
    .all<{ key: string; value: string; updated_at: string }>();

  const result: Record<string, { value: string; masked: string; updated_at: string }> = {};
  for (const row of rows.results) {
    result[row.key] = {
      value: row.value,
      masked: maskValue(row.key, row.value),
      updated_at: row.updated_at,
    };
  }

  return c.json({ settings: result });
});

/** 批量更新设置 */
settings.put("/", async (c) => {
  const body = await c.req.json<Record<string, string>>();

  const stmts = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(key)) continue;
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
      ).bind(key, value, value)
    );
  }

  if (stmts.length > 0) {
    await c.env.DB.batch(stmts);
  }

  return c.json({ ok: true });
});

/** SECRET 类型的值只显示前4位 + **** */
function maskValue(key: string, value: string): string {
  if ((key.includes("SECRET") || key === "ADMIN_PASSWORD") && value.length > 4) {
    return value.slice(0, 4) + "****";
  }
  return value;
}

export default settings;
