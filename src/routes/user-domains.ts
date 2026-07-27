import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, requireAdmin, getUserId, type ApiKeyContext, type UserContext } from "../auth";
import { checkDomainMx, getMxGuide, normalizeDomain } from "../dns";
import { autoEnableEmailRouting, getCloudflareCredentials } from "../cloudflare";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const userDomains = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

userDomains.use("*", requireJwt());

/** 声明域名归属并返回本人全部域名（调用前需自行确认未被他人占用） */
async function claimDomain(db: D1Database, userId: string, name: string): Promise<string[]> {
  await db.prepare("INSERT OR IGNORE INTO user_domains (user_id, domain_name) VALUES (?, ?)")
    .bind(userId, name).run();
  const owned = await db.prepare(
    "SELECT domain_name FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string }>();
  return owned.results.map((r) => r.domain_name);
}

/** 归属冲突 / 共享域名检查；返回 null 表示可声明，否则返回错误响应 */
async function checkClaimable(c: { env: Env }, userId: string, name: string): Promise<{ error: string; status: 409 } | null> {
  const claimed = await c.env.DB.prepare("SELECT user_id FROM user_domains WHERE domain_name = ?")
    .bind(name).first<{ user_id: string }>();
  if (claimed && claimed.user_id !== userId) {
    return { error: "domain already claimed by another user", status: 409 };
  }
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'SHARED_INBOX_DOMAIN'")
    .first<{ value: string }>();
  const sharedDomain = (row?.value ?? "").trim().toLowerCase();
  if (sharedDomain && sharedDomain === name) {
    return { error: "this is the shared inbox domain and cannot be claimed", status: 409 };
  }
  return null;
}

/** 列出当前用户已声明的域名 */
userDomains.get("/", async (c) => {
  const userId = getUserId(c);
  const rows = await c.env.DB.prepare(
    "SELECT domain_name, created_at FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string; created_at: string }>();
  return c.json({ domains: rows.results });
});

/** 域名接入指引：所需 MX / SPF 与操作步骤 */
userDomains.get("/guide", async (c) => {
  return c.json(getMxGuide());
});

/** 检测域名 MX 是否已指向 Cloudflare Email Routing */
userDomains.post("/check-mx", async (c) => {
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
 * 导入域名并尽量自动启用收信，结果写入当前用户的 user_domains：
 * - admin + 有 CF 凭据 + auto_enable：必要时创建 Zone，Email Routing + catch-all → Worker
 *   （Zone 未 active 时返回 pending_ns + nameservers）
 * - 其余：仅 MX 检测后写入（force 可跳过 MX）
 */
userDomains.post("/import", async (c) => {
  const body = await c.req
    .json<{ domain?: string; force?: boolean; auto_enable?: boolean; create_zone?: boolean }>()
    .catch(() => ({} as { domain?: string; force?: boolean; auto_enable?: boolean; create_zone?: boolean }));
  const raw = body.domain?.trim();
  if (!raw) return c.json({ error: "domain required" }, 400);

  const domain = normalizeDomain(raw);
  if (!domain) return c.json({ error: "invalid domain" }, 400);

  const user = c.get("user")!;
  const userId = getUserId(c);

  const conflict = await checkClaimable(c, userId, domain);
  if (conflict) return c.json({ error: conflict.error }, conflict.status);

  // admin 默认自动启用（有 CF 凭据时）
  if (user.role === "admin" && body.auto_enable !== false) {
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

      const domains = await claimDomain(c.env.DB, userId, domain);
      return c.json({
        ok: true,
        domain,
        mx,
        forced: false,
        enabled: true,
        auto_enabled: true,
        scope: "user",
        domains,
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
    return c.json({ error: "mx_not_ready", message: mx.message, mx }, 400);
  }

  const domains = await claimDomain(c.env.DB, userId, mx.domain);
  return c.json({
    ok: true,
    domain: mx.domain,
    mx,
    forced: !mx.ok && !!body.force,
    auto_enabled: false,
    scope: "user",
    domains,
  });
});

/** 从 Cloudflare API 同步主账号 Zone 域名到自己的 user_domains — admin only */
userDomains.post("/sync", requireAdmin(), async (c) => {
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
      const dnsData = await dnsRes.json() as { success: boolean; result?: { name: string }[] };
      if (dnsData.success && dnsData.result) {
        for (const record of dnsData.result) {
          if (record.name !== zone.name && !allDomains.includes(record.name)) {
            allDomains.push(record.name);
          }
        }
      }
    } catch {}
  }

  const userId = getUserId(c);
  if (allDomains.length > 0) {
    await c.env.DB.batch(
      allDomains.map((name) =>
        c.env.DB.prepare("INSERT OR IGNORE INTO user_domains (user_id, domain_name) VALUES (?, ?)")
          .bind(userId, name.toLowerCase())
      )
    );
  }

  return c.json({ ok: true, domains: allDomains });
});

/** 声明一个域名 */
userDomains.post("/", async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "").trim().toLowerCase();
  if (!name || !DOMAIN_RE.test(name)) {
    return c.json({ error: "invalid domain" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT user_id FROM user_domains WHERE domain_name = ?")
    .bind(name).first<{ user_id: string }>();
  if (existing?.user_id === userId) return c.json({ ok: true, name });

  const conflict = await checkClaimable(c, userId, name);
  if (conflict) return c.json({ error: conflict.error }, conflict.status);

  await c.env.DB.prepare(
    "INSERT INTO user_domains (user_id, domain_name) VALUES (?, ?)"
  ).bind(userId, name).run();
  return c.json({ ok: true, name }, 201);
});

/** 取消声明 */
userDomains.delete("/:name", async (c) => {
  const userId = getUserId(c);
  const name = decodeURIComponent(c.req.param("name") ?? "").trim().toLowerCase();
  if (!name) return c.json({ error: "name required" }, 400);

  // 拒绝带账号的域名删除（让用户先清理）
  const inUse = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE user_id = ? AND provider = 'domain' AND email LIKE ?"
  ).bind(userId, `%@${name}`).first<{ n: number }>();
  if ((inUse?.n ?? 0) > 0) {
    return c.json({ error: `${inUse?.n} mailbox(es) still use this domain — delete them first` }, 409);
  }

  await c.env.DB.prepare("DELETE FROM user_domains WHERE user_id = ? AND domain_name = ?")
    .bind(userId, name).run();
  return c.json({ ok: true });
});

export default userDomains;
