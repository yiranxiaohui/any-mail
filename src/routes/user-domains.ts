import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, getUserId, type ApiKeyContext, type UserContext } from "../auth";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const userDomains = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

userDomains.use("*", requireJwt());

/** 列出当前用户已声明的域名 */
userDomains.get("/", async (c) => {
  const userId = getUserId(c);
  const rows = await c.env.DB.prepare(
    "SELECT domain_name, created_at FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string; created_at: string }>();
  return c.json({ domains: rows.results });
});

/** 声明一个域名 */
userDomains.post("/", async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "").trim().toLowerCase();
  if (!name || !DOMAIN_RE.test(name)) {
    return c.json({ error: "invalid domain" }, 400);
  }

  // 已被任何用户占用？
  const existing = await c.env.DB.prepare("SELECT user_id FROM user_domains WHERE domain_name = ?")
    .bind(name).first<{ user_id: string }>();
  if (existing) {
    if (existing.user_id === userId) return c.json({ ok: true, name });
    return c.json({ error: "domain already claimed by another user" }, 409);
  }

  // 与 admin 全局 EMAIL_DOMAINS 重合也禁止（避免歧义）
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
    .first<{ value: string }>();
  const globalDomains = row?.value ? row.value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) : [];
  if (globalDomains.includes(name)) {
    return c.json({ error: "domain is already available to all users (admin global list)" }, 409);
  }

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
