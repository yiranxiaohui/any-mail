import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, requireAdmin, getUserId, type ApiKeyContext, type UserContext } from "../auth";

// 系统级（仅 admin 可读写）
const SYSTEM_KEYS = [
  "ADMIN_PASSWORD",
  "EMAIL_DOMAINS",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
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

/** 获取可用域名列表：admin 全局 EMAIL_DOMAINS + 当前用户在 user_domains 里声明的 */
settings.get("/domains", async (c) => {
  const userId = getUserId(c);
  const [globalRow, userRows] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'"),
    c.env.DB.prepare("SELECT domain_name FROM user_domains WHERE user_id = ?").bind(userId),
  ]);
  const globalValue = (globalRow?.results[0] as { value: string } | undefined)?.value ?? "";
  const globals = globalValue.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const owned = ((userRows?.results ?? []) as { domain_name: string }[]).map((r) => r.domain_name.toLowerCase());
  const all = Array.from(new Set([...globals, ...owned])).sort();
  return c.json({ domains: all.map((name) => ({ name })) });
});

/** 从 Cloudflare API 同步域名到 EMAIL_DOMAINS 配置 — admin only */
settings.post("/domains/sync", requireAdmin(), async (c) => {
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
