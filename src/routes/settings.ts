import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, type ApiKeyContext } from "../auth";

const ALLOWED_KEYS = [
  "ADMIN_PASSWORD",
  "RESEND_API_KEY",
  "EMAIL_DOMAINS",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
];

const settings = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>();

// 设置页面（含管理员密码等敏感数据）仅限 JWT
settings.use("*", requireJwt());

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

/** 获取已配置的域名列表（从 DB 读取） */
settings.get("/domains", async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
    .first<{ value: string }>();

  if (!row?.value) {
    return c.json({ domains: [] });
  }

  const domains = row.value.split(",").map((d) => d.trim()).filter(Boolean)
    .map((name) => ({ name }));

  return c.json({ domains });
});

/** 从 Cloudflare API 同步域名到 EMAIL_DOMAINS 配置 */
settings.post("/domains/sync", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID')"
  ).all<{ key: string; value: string }>();

  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const apiToken = c.env.CLOUDFLARE_API_TOKEN || map.get("CLOUDFLARE_API_TOKEN");
  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID || map.get("CLOUDFLARE_ACCOUNT_ID");

  if (!apiToken || !accountId) {
    return c.json({ error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required." }, 400);
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  const data = await res.json() as {
    success: boolean;
    result?: { id: string; name: string }[];
    errors?: { message: string }[];
  };

  if (!data.success) {
    return c.json({ error: data.errors?.[0]?.message || "Failed to fetch domains" }, 500);
  }

  const allDomains: string[] = [];

  for (const zone of data.result ?? []) {
    allDomains.push(zone.name);

    // 提取子域
    try {
      const dnsRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records?type=MX&per_page=100`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      const dnsData = await dnsRes.json() as {
        success: boolean;
        result?: { name: string }[];
      };
      if (dnsData.success && dnsData.result) {
        for (const record of dnsData.result) {
          if (record.name !== zone.name && !allDomains.includes(record.name)) {
            allDomains.push(record.name);
          }
        }
      }
    } catch {}
  }

  // 保存到 DB
  const value = allDomains.join(",");
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('EMAIL_DOMAINS', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
  ).bind(value, value).run();

  return c.json({ ok: true, domains: allDomains });
});

function maskValue(key: string, value: string): string {
  if ((key.includes("SECRET") || key === "ADMIN_PASSWORD" || key === "RESEND_API_KEY" || key === "CLOUDFLARE_API_TOKEN") && value.length > 4) {
    return value.slice(0, 4) + "****";
  }
  return value;
}

export default settings;
