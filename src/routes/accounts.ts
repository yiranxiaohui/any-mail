import { Hono } from "hono";
import type { Env } from "../types";
import { requireScope, getUserId, type ApiKeyContext, type UserContext } from "../auth";

const accounts = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

/** 列出邮箱账号（支持分页和搜索） */
accounts.get("/", requireScope("accounts:read"), async (c) => {
  const userId = getUserId(c);
  const search = c.req.query("search");
  const providerQuery = c.req.query("provider");
  const tagQuery = c.req.query("tag");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");

  const keyProvider = c.get("apiKey")?.provider ?? null;
  const provider = keyProvider ?? providerQuery;

  let sql = "SELECT id, provider, email, expires_at, tag, created_at, updated_at FROM accounts WHERE user_id = ?";
  let countSql = "SELECT COUNT(*) as total FROM accounts WHERE user_id = ?";
  const params: string[] = [userId];
  const countParams: string[] = [userId];
  const conditions: string[] = [];

  if (search) {
    conditions.push("email LIKE ?");
    params.push(`%${search}%`);
    countParams.push(`%${search}%`);
  }
  if (provider) {
    conditions.push("provider = ?");
    params.push(provider);
    countParams.push(provider);
  }
  if (tagQuery !== undefined) {
    // tag=__untagged__ 过滤未分组；其余按字符串完全匹配
    if (tagQuery === "__untagged__") {
      conditions.push("(tag IS NULL OR tag = '')");
    } else if (tagQuery) {
      conditions.push("tag = ?");
      params.push(tagQuery);
      countParams.push(tagQuery);
    }
  }
  if (conditions.length > 0) {
    const extra = " AND " + conditions.join(" AND ");
    sql += extra;
    countSql += extra;
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(String(limit), String(offset));

  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(sql).bind(...params),
    c.env.DB.prepare(countSql).bind(...countParams),
  ]);

  const rows = batchResults[0]?.results ?? [];
  const total = (batchResults[1]?.results[0] as { total: number })?.total ?? 0;

  return c.json({ accounts: rows, meta: { limit, offset, total } });
});

/** 列出所有分组（用户创建的 + 有账户占用的），以及每个分组的账户数 */
accounts.get("/tags", requireScope("accounts:read"), async (c) => {
  const userId = getUserId(c);
  const keyProvider = c.get("apiKey")?.provider ?? null;

  let countSql = "SELECT tag, COUNT(*) as count FROM accounts WHERE user_id = ?";
  const countParams: string[] = [userId];
  if (keyProvider) {
    countSql += " AND provider = ?";
    countParams.push(keyProvider);
  }
  countSql += " GROUP BY tag";

  const [countRows, groupRows] = await c.env.DB.batch([
    c.env.DB.prepare(countSql).bind(...countParams),
    c.env.DB.prepare("SELECT name FROM tag_groups WHERE user_id = ? ORDER BY name").bind(userId),
  ]);

  const countMap = new Map<string, number>();
  let untagged = 0;
  for (const r of (countRows?.results ?? []) as { tag: string | null; count: number }[]) {
    if (r.tag && r.tag.trim()) countMap.set(r.tag, r.count);
    else untagged += r.count;
  }
  for (const r of (groupRows?.results ?? []) as { name: string }[]) {
    if (!countMap.has(r.name)) countMap.set(r.name, 0);
  }

  const tags: { tag: string | null; count: number }[] = [];
  if (untagged > 0) tags.push({ tag: null, count: untagged });
  for (const [name, count] of Array.from(countMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    tags.push({ tag: name, count });
  }
  return c.json({ tags });
});

/** 创建一个空分组 */
accounts.post("/tags", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{ name: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if (name.length > 50) return c.json({ error: "name too long" }, 400);

  try {
    await c.env.DB.prepare("INSERT INTO tag_groups (user_id, name) VALUES (?, ?)").bind(userId, name).run();
  } catch (err) {
    // UNIQUE 冲突：分组已存在，直接返回 ok（幂等）
    const msg = err instanceof Error ? err.message : "";
    if (!/UNIQUE|constraint/i.test(msg)) {
      return c.json({ error: msg || "failed to create group" }, 500);
    }
  }
  return c.json({ ok: true, name });
});

/** 删除分组：从 tag_groups 移除并把落在该分组下的账户 tag 清空 */
accounts.delete("/tags/:name", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const name = decodeURIComponent(c.req.param("name") ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tag_groups WHERE user_id = ? AND name = ?").bind(userId, name),
    c.env.DB.prepare("UPDATE accounts SET tag = NULL, updated_at = datetime('now') WHERE user_id = ? AND tag = ?").bind(userId, name),
  ]);
  return c.json({ ok: true });
});

/** 重命名分组 */
accounts.patch("/tags/:name", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const oldName = decodeURIComponent(c.req.param("name") ?? "").trim();
  const body = await c.req.json<{ name?: string }>();
  const newName = body.name?.trim();

  if (!oldName) return c.json({ error: "old name required" }, 400);
  if (!newName) return c.json({ error: "new name required" }, 400);
  if (newName.length > 50) return c.json({ error: "name too long" }, 400);
  if (oldName === newName) return c.json({ ok: true, name: newName });

  const target = await c.env.DB.prepare("SELECT name FROM tag_groups WHERE user_id = ? AND name = ?")
    .bind(userId, newName).first();
  const merged = !!target;

  if (merged) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE accounts SET tag = ?, updated_at = datetime('now') WHERE user_id = ? AND tag = ?").bind(newName, userId, oldName),
      c.env.DB.prepare("DELETE FROM tag_groups WHERE user_id = ? AND name = ?").bind(userId, oldName),
    ]);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO tag_groups (user_id, name) VALUES (?, ?)").bind(userId, newName),
      c.env.DB.prepare("UPDATE accounts SET tag = ?, updated_at = datetime('now') WHERE user_id = ? AND tag = ?").bind(newName, userId, oldName),
      c.env.DB.prepare("DELETE FROM tag_groups WHERE user_id = ? AND name = ?").bind(userId, oldName),
    ]);
  }

  return c.json({ ok: true, name: newName, merged });
});

/** 查询单个账号 */
accounts.get("/:id", requireScope("accounts:read"), async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");
  const keyProvider = c.get("apiKey")?.provider ?? null;
  const account = await c.env.DB.prepare(
    "SELECT id, provider, email, password, client_id, refresh_token, expires_at, tag, created_at, updated_at FROM accounts WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<{ provider: string }>();

  if (!account) return c.json({ error: "not found" }, 404);
  if (keyProvider && account.provider !== keyProvider) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(account);
});

/** 创建域名邮箱账号，支持过期时间 */
accounts.post("/", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  // API key 必须绑定 provider=domain 才能创建域名邮箱
  const key = c.get("apiKey");
  if (key && key.provider !== "domain") {
    return c.json({ error: "api key must be bound to provider=domain to create accounts" }, 403);
  }

  const body = await c.req.json<{ email: string; expires_at?: string | null }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid email" }, 400);
  }

  // 域名邮件的收件人在系统内必须唯一（投递时只能给一个 user）
  const existing = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE email = ? AND provider = 'domain'"
  ).bind(email).first();
  if (existing) {
    return c.json({ error: "this address is already claimed" }, 409);
  }

  const id = crypto.randomUUID();
  const expiresAt = body.expires_at ?? null;
  await c.env.DB.prepare(
    "INSERT INTO accounts (id, user_id, provider, email, expires_at) VALUES (?, ?, 'domain', ?, ?)"
  ).bind(id, userId, email, expiresAt).run();

  return c.json({ ok: true, account: { id, provider: "domain", email, expires_at: expiresAt } }, 201);
});

/** 批量导入微软邮箱（outlook/hotmail） */
accounts.post("/import", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const key = c.get("apiKey");
  if (key && key.provider !== "outlook") {
    return c.json({ error: "api key must be bound to provider=outlook to import accounts" }, 403);
  }

  const body = await c.req.json<{ text: string }>();
  if (!body.text?.trim()) {
    return c.json({ error: "empty input" }, 400);
  }

  const lines = body.text.trim().split("\n").filter((l) => l.trim());
  const results: { email: string; status: string }[] = [];

  for (const line of lines) {
    const parts = line.split("----").map((s) => s.trim());
    if (parts.length < 3) {
      results.push({ email: parts[0] || "unknown", status: "invalid format" });
      continue;
    }

    let email: string;
    let password = "";
    let clientId: string;
    let refreshToken: string;

    if (parts.length === 3) {
      [email, clientId, refreshToken] = parts as [string, string, string];
    } else {
      email = parts[0]!;
      password = parts[1]!;
      clientId = parts[2]!;
      refreshToken = parts[3]!;
    }
    if (!email.includes("@")) {
      results.push({ email, status: "invalid email" });
      continue;
    }

    const lowered = email.toLowerCase();
    // accounts.email is globally UNIQUE — reject if claimed by another user
    const existing = await c.env.DB.prepare("SELECT id, user_id FROM accounts WHERE email = ?")
      .bind(lowered).first<{ id: string; user_id: string }>();
    if (existing && existing.user_id !== userId) {
      results.push({ email, status: "claimed by another user" });
      continue;
    }

    try {
      const id = existing?.id ?? crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO accounts (id, user_id, provider, email, password, client_id, refresh_token)
         VALUES (?, ?, 'outlook', ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET password=?, client_id=?, refresh_token=?, updated_at=datetime('now')`
      ).bind(id, userId, lowered, password || null, clientId, refreshToken, password || null, clientId, refreshToken).run();
      results.push({ email, status: "ok" });
    } catch (err) {
      results.push({ email, status: err instanceof Error ? err.message : "insert failed" });
    }
  }

  const success = results.filter((r) => r.status === "ok").length;
  return c.json({ ok: true, total: lines.length, success, results });
});

async function assertAccountOwned(
  c: { env: Env; get: (k: string) => ApiKeyContext | UserContext | undefined },
  id: string,
  userId: string,
): Promise<Response | null> {
  const row = await c.env.DB.prepare("SELECT provider, user_id FROM accounts WHERE id = ?")
    .bind(id).first<{ provider: string; user_id: string }>();
  if (!row || row.user_id !== userId) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  const key = c.get("apiKey") as ApiKeyContext | undefined;
  if (key?.provider && row.provider !== key.provider) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  return null;
}

/** 编辑账号信息 */
accounts.patch("/:id", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id")!;
  const guard = await assertAccountOwned(c, id, userId);
  if (guard) return guard;

  const body = await c.req.json<{ email?: string; password?: string | null; expires_at?: string | null; client_id?: string | null; refresh_token?: string | null; tag?: string | null }>();

  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (body.email !== undefined) {
    fields.push("email = ?");
    values.push(body.email.trim().toLowerCase());
  }
  if (body.password !== undefined) {
    fields.push("password = ?");
    values.push(body.password);
  }
  if (body.expires_at !== undefined) {
    fields.push("expires_at = ?");
    values.push(body.expires_at);
  }
  if (body.client_id !== undefined) {
    fields.push("client_id = ?");
    values.push(body.client_id);
  }
  if (body.refresh_token !== undefined) {
    fields.push("refresh_token = ?");
    values.push(body.refresh_token);
  }
  if (body.tag !== undefined) {
    fields.push("tag = ?");
    const normalized = typeof body.tag === "string" ? body.tag.trim() : body.tag;
    values.push(normalized ? normalized : null);
  }

  if (fields.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);
  values.push(userId);

  await c.env.DB.prepare(
    `UPDATE accounts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...values).run();

  return c.json({ ok: true });
});

/** 用账号密码重新获取 refresh_token (ROPC) */
accounts.post("/:id/reauth", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id")!;
  const guard = await assertAccountOwned(c, id, userId);
  if (guard) return guard;

  const account = await c.env.DB.prepare(
    "SELECT id, email, password, client_id FROM accounts WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ id: string; email: string; password: string | null; client_id: string | null }>();

  if (!account) return c.json({ error: "not found" }, 404);
  if (!account.password) return c.json({ error: "no password stored for this account" }, 400);
  if (!account.client_id) return c.json({ error: "no client_id stored for this account" }, 400);

  const personalDomains = ["hotmail.com", "outlook.com", "live.com", "msn.com"];
  const domain = account.email.split("@")[1]?.toLowerCase() ?? "";
  const tenant = personalDomains.includes(domain) ? "consumers" : "organizations";

  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.client_id,
      grant_type: "password",
      username: account.email,
      password: account.password,
      scope: "openid email Mail.Read offline_access",
    }),
  });

  const token = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!token.access_token) {
    return c.json({ error: token.error_description || token.error || "ROPC auth failed" }, 400);
  }

  const expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;

  await c.env.DB.prepare(
    "UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).bind(token.access_token, token.refresh_token ?? "", expiresAt, id, userId).run();

  return c.json({ ok: true, email: account.email });
});

/** 批量设置标签 */
accounts.post("/bulk-tag", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{ ids: string[]; tag: string | null }>();
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ error: "ids required" }, 400);
  }
  const normalized = typeof body.tag === "string" ? body.tag.trim() : body.tag;
  const tag = normalized ? normalized : null;

  const key = c.get("apiKey");
  const keyProvider = key?.provider ?? null;

  const placeholders = body.ids.map(() => "?").join(",");
  let sql = `UPDATE accounts SET tag = ?, updated_at = datetime('now') WHERE user_id = ? AND id IN (${placeholders})`;
  const values: (string | null)[] = [tag, userId, ...body.ids];
  if (keyProvider) {
    sql += " AND provider = ?";
    values.push(keyProvider);
  }

  const res = await c.env.DB.prepare(sql).bind(...values).run();

  if (tag) {
    try {
      await c.env.DB.prepare("INSERT OR IGNORE INTO tag_groups (user_id, name) VALUES (?, ?)").bind(userId, tag).run();
    } catch {
      // 忽略
    }
  }

  return c.json({ ok: true, updated: res.meta?.changes ?? 0 });
});

/** 删除账号及其所有邮件 */
accounts.delete("/:id", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id")!;
  const guard = await assertAccountOwned(c, id, userId);
  if (guard) return guard;

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM emails WHERE account_id = ? AND user_id = ?").bind(id, userId),
    c.env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
  return c.json({ ok: true });
});

export default accounts;
