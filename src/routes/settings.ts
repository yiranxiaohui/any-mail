import { Hono } from "hono";
import type { Env } from "../types";

const ALLOWED_KEYS = [
  "ADMIN_PASSWORD",
  "RESEND_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
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
/** 从 Cloudflare API 获取域名列表 */
settings.get("/domains", async (c) => {
  // 优先从 env 读取（部署时设置），其次从 DB settings 读取
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID')"
  ).all<{ key: string; value: string }>();

  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const apiToken = c.env.CLOUDFLARE_API_TOKEN || map.get("CLOUDFLARE_API_TOKEN");
  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID || map.get("CLOUDFLARE_ACCOUNT_ID");

  if (!apiToken || !accountId) {
    return c.json({ error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required." }, 400);
  }

  // 获取所有域名
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  const data = await res.json() as {
    success: boolean;
    result?: { id: string; name: string; status: string }[];
    errors?: { message: string }[];
  };

  if (!data.success) {
    return c.json({ error: data.errors?.[0]?.message || "Failed to fetch domains" }, 500);
  }

  const domains = (data.result ?? []).map((z) => ({
    id: z.id,
    name: z.name,
    status: z.status,
  }));

  return c.json({ domains });
});

function maskValue(key: string, value: string): string {
  if ((key.includes("SECRET") || key === "ADMIN_PASSWORD" || key === "RESEND_API_KEY" || key === "CLOUDFLARE_API_TOKEN") && value.length > 4) {
    return value.slice(0, 4) + "****";
  }
  return value;
}

export default settings;
