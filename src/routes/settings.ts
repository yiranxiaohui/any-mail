import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, requireAdmin, getUserId, type ApiKeyContext, type UserContext } from "../auth";
import { checkDomainMx, getMxGuide, normalizeDomain } from "../dns";
import { autoEnableEmailRouting, getCloudflareCredentials } from "../cloudflare";

// 系统级（仅 admin 可读写）
const SYSTEM_KEYS = [
  "ADMIN_PASSWORD",
  "EMAIL_DOMAINS",
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

/** 域名接入指引：所需 MX / SPF 与操作步骤 */
settings.get("/domains/guide", async (c) => {
  return c.json(getMxGuide());
});

/** 检测域名 MX 是否已指向 Cloudflare Email Routing */
settings.post("/domains/check-mx", async (c) => {
  const body = await c.req.json<{ domain?: string }>().catch(() => ({} as { domain?: string }));
  const domain = body.domain?.trim();
  if (!domain) return c.json({ error: "domain required" }, 400);

  try {
    const result = await checkDomainMx(domain);
    return c.json(result);
  } catch (err) {
    return c.json(
      {
        domain: normalizeDomain(domain) ?? domain,
        ok: false,
        records: [],
        matched: [],
        missing: [],
        extra: [],
        message: "dns_error",
        error: err instanceof Error ? err.message : "DNS lookup failed",
      },
      502
    );
  }
});

/**
 * 一键自动启用（admin only）：
 * 1) 在当前 CF 账号查找/创建 Zone（full 托管）
 * 2) Zone 未 active 时返回 pending_ns + nameservers（用户改注册商 NS 后重试）
 * 3) 启用 Email Routing（写 MX）
 * 4) Catch-all → Worker（默认 any-mail）
 * 5) 可选写入 EMAIL_DOMAINS
 *
 * Token 需 Zone:Edit（创建）+ Zone:Read + Email Routing Edit。
 */
settings.post("/domains/auto-enable", requireAdmin(), async (c) => {
  const body = await c.req
    .json<{ domain?: string; import?: boolean; force_import?: boolean; create_zone?: boolean }>()
    .catch(() => ({} as { domain?: string; import?: boolean; force_import?: boolean; create_zone?: boolean }));
  const raw = body.domain?.trim();
  if (!raw) return c.json({ error: "domain required" }, 400);

  const domain = normalizeDomain(raw);
  if (!domain) return c.json({ error: "invalid domain" }, 400);

  const creds = await getCloudflareCredentials(c.env);
  if (!creds) {
    return c.json(
      { error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required." },
      400
    );
  }

  const enable = await autoEnableEmailRouting(domain, creds, {
    createIfMissing: body.create_zone !== false,
  });
  // 业务失败也返回 200，便于前端展示 steps（HTTP 错误仅用于缺参/凭据）
  if (!enable.ok) {
    return c.json({
      ok: false,
      error: enable.error ?? "auto_enable_failed",
      domain: enable.domain,
      zone_id: enable.zone_id,
      zone_status: enable.zone_status,
      nameservers: enable.nameservers,
      pending_ns: enable.pending_ns,
      zone_created: enable.zone_created,
      worker: enable.worker,
      steps: enable.steps,
    });
  }

  // 默认导入到全局 EMAIL_DOMAINS；import=false 时只配 CF
  let domains: string[] | undefined;
  let mx = null as Awaited<ReturnType<typeof checkDomainMx>> | null;
  const shouldImport = body.import !== false;

  if (shouldImport) {
    try {
      mx = await checkDomainMx(domain);
    } catch {
      mx = null;
    }

    // 自动启用后公网 MX 可能尚未传播；默认允许写入（force_import 默认 true）
    const forceImport = body.force_import !== false;
    if (mx && !mx.ok && !forceImport) {
      return c.json({
        ok: true,
        domain,
        enabled: true,
        imported: false,
        reason: "mx_not_ready",
        mx,
        steps: enable.steps,
        worker: enable.worker,
        zone_id: enable.zone_id,
      });
    }

    const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
      .first<{ value: string }>();
    const existing = row?.value
      ? row.value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
      : [];
    if (!existing.includes(domain)) {
      existing.push(domain);
      const value = existing.join(",");
      await c.env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('EMAIL_DOMAINS', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
      )
        .bind(value, value)
        .run();
    }
    domains = existing;
  }

  return c.json({
    ok: true,
    domain,
    enabled: true,
    imported: shouldImport,
    domains,
    mx,
    steps: enable.steps,
    worker: enable.worker,
    zone_id: enable.zone_id,
    zone_status: enable.zone_status,
    nameservers: enable.nameservers,
    zone_created: enable.zone_created,
  });
});

/**
 * 导入域名并尽量自动启用收信：
 * - admin + 有 CF 凭据：必要时在本账号创建 Zone，Email Routing + catch-all → Worker，再写 EMAIL_DOMAINS
 *   （Zone 未 active 时返回 pending_ns + nameservers）
 * - admin 无凭据 / auto_enable=false：仅 MX 检测后写入（force 可跳过 MX）
 * - 普通用户：写入 user_domains（个人声明）
 */
settings.post("/domains/import", async (c) => {
  const body = await c.req
    .json<{ domain?: string; force?: boolean; auto_enable?: boolean; create_zone?: boolean }>()
    .catch(() => ({} as { domain?: string; force?: boolean; auto_enable?: boolean; create_zone?: boolean }));
  const raw = body.domain?.trim();
  if (!raw) return c.json({ error: "domain required" }, 400);

  const domain = normalizeDomain(raw);
  if (!domain) return c.json({ error: "invalid domain" }, 400);

  const user = c.get("user")!;
  const userId = getUserId(c);
  const wantAutoEnable = body.auto_enable !== false;

  // admin 默认自动启用（有 CF 凭据时）
  if (user.role === "admin" && wantAutoEnable) {
    const creds = await getCloudflareCredentials(c.env);
    if (creds) {
      const enable = await autoEnableEmailRouting(domain, creds, {
        createIfMissing: body.create_zone !== false,
      });
      if (!enable.ok) {
        return c.json({
          ok: false,
          error: enable.error ?? "auto_enable_failed",
          domain: enable.domain,
          zone_id: enable.zone_id,
          zone_status: enable.zone_status,
          nameservers: enable.nameservers,
          pending_ns: enable.pending_ns,
          zone_created: enable.zone_created,
          worker: enable.worker,
          steps: enable.steps,
        });
      }

      let mx = null as Awaited<ReturnType<typeof checkDomainMx>> | null;
      try {
        mx = await checkDomainMx(domain);
      } catch {
        mx = null;
      }

      const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
        .first<{ value: string }>();
      const existing = row?.value
        ? row.value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
        : [];
      if (!existing.includes(domain)) {
        existing.push(domain);
        const value = existing.join(",");
        await c.env.DB.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES ('EMAIL_DOMAINS', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
        )
          .bind(value, value)
          .run();
      }

      return c.json({
        ok: true,
        domain,
        mx,
        forced: false,
        enabled: true,
        auto_enabled: true,
        scope: "global",
        domains: existing,
        steps: enable.steps,
        worker: enable.worker,
        zone_id: enable.zone_id,
        zone_status: enable.zone_status,
        nameservers: enable.nameservers,
        zone_created: enable.zone_created,
      });
    }
  }

  // 无 CF 自动启用：走 MX 检测后写入
  let mx;
  try {
    mx = await checkDomainMx(raw);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : "DNS lookup failed",
        message: "dns_error",
      },
      502
    );
  }

  if (mx.message === "invalid domain") {
    return c.json({ error: "invalid domain" }, 400);
  }

  if (!mx.ok && !body.force) {
    return c.json(
      {
        error: "mx_not_ready",
        message: mx.message,
        mx,
      },
      400
    );
  }

  if (user.role === "admin") {
    const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
      .first<{ value: string }>();
    const existing = row?.value
      ? row.value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
      : [];

    if (!existing.includes(mx.domain)) {
      existing.push(mx.domain);
      const value = existing.join(",");
      await c.env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('EMAIL_DOMAINS', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
      )
        .bind(value, value)
        .run();
    }

    return c.json({
      ok: true,
      domain: mx.domain,
      mx,
      forced: !mx.ok && !!body.force,
      auto_enabled: false,
      scope: "global",
      domains: existing,
    });
  }

  // 普通用户：写入 user_domains
  const claimed = await c.env.DB.prepare("SELECT user_id FROM user_domains WHERE domain_name = ?")
    .bind(mx.domain)
    .first<{ user_id: string }>();
  if (claimed && claimed.user_id !== userId) {
    return c.json({ error: "domain already claimed by another user" }, 409);
  }

  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('EMAIL_DOMAINS', 'SHARED_INBOX_DOMAIN')"
  ).all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const globalDomains = (map.get("EMAIL_DOMAINS") ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const sharedDomain = (map.get("SHARED_INBOX_DOMAIN") ?? "").trim().toLowerCase();
  if (globalDomains.includes(mx.domain)) {
    return c.json({ error: "domain is already available to all users (admin global list)" }, 409);
  }
  if (sharedDomain && sharedDomain === mx.domain) {
    return c.json({ error: "this is the shared inbox domain and cannot be claimed" }, 409);
  }

  if (!claimed) {
    await c.env.DB.prepare(
      "INSERT INTO user_domains (user_id, domain_name) VALUES (?, ?)"
    ).bind(userId, mx.domain).run();
  }

  const owned = await c.env.DB.prepare(
    "SELECT domain_name FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string }>();

  return c.json({
    ok: true,
    domain: mx.domain,
    mx,
    forced: !mx.ok && !!body.force,
    auto_enabled: false,
    scope: "user",
    domains: owned.results.map((r) => r.domain_name),
  });
});

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
