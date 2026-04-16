import { Hono } from "hono";
import type { Env } from "../types";

const accounts = new Hono<{ Bindings: Env }>();

/** 列出邮箱账号（支持分页和搜索） */
accounts.get("/", async (c) => {
  const search = c.req.query("search");
  const provider = c.req.query("provider");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");

  let sql = "SELECT id, provider, email, expires_at, created_at, updated_at FROM accounts";
  let countSql = "SELECT COUNT(*) as total FROM accounts";
  const params: string[] = [];
  const countParams: string[] = [];
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
  if (conditions.length > 0) {
    const where = " WHERE " + conditions.join(" AND ");
    sql += where;
    countSql += where;
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

/** 查询单个账号 */
accounts.get("/:id", async (c) => {
  const id = c.req.param("id");
  const account = await c.env.DB.prepare(
    "SELECT id, provider, email, password, client_id, refresh_token, expires_at, created_at, updated_at FROM accounts WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!account) return c.json({ error: "not found" }, 404);
  return c.json(account);
});

/** 创建域名邮箱账号，支持过期时间 */
accounts.post("/", async (c) => {
  const body = await c.req.json<{ email: string; expires_at?: string | null }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid email" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE email = ? AND provider = 'domain'"
  ).bind(email).first();
  if (existing) {
    return c.json({ error: "account already exists" }, 409);
  }

  const id = crypto.randomUUID();
  const expiresAt = body.expires_at ?? null;
  await c.env.DB.prepare(
    "INSERT INTO accounts (id, provider, email, expires_at) VALUES (?, 'domain', ?, ?)"
  ).bind(id, email, expiresAt).run();

  return c.json({ ok: true, account: { id, provider: "domain", email, expires_at: expiresAt } }, 201);
});

/** 批量导入微软邮箱（outlook/hotmail）
 *  格式：每行一个，字段用 ---- 分隔
 *  账号----密码----ssid----令牌(refresh_token)
 */
accounts.post("/import", async (c) => {
  const body = await c.req.json<{ text: string }>();
  if (!body.text?.trim()) {
    return c.json({ error: "empty input" }, 400);
  }

  const lines = body.text.trim().split("\n").filter((l) => l.trim());
  const results: { email: string; status: string }[] = [];
  const stmts: D1PreparedStatement[] = [];

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
      // 格式: 邮箱----client_id----refresh_token
      [email, clientId, refreshToken] = parts as [string, string, string];
    } else {
      // 格式: 邮箱----密码----client_id----refresh_token
      email = parts[0]!;
      password = parts[1]!;
      clientId = parts[2]!;
      refreshToken = parts[3]!;
    }
    if (!email.includes("@")) {
      results.push({ email, status: "invalid email" });
      continue;
    }

    const id = crypto.randomUUID();
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO accounts (id, provider, email, password, client_id, refresh_token)
         VALUES (?, 'outlook', ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET password=?, client_id=?, refresh_token=?, updated_at=datetime('now')`
      ).bind(id, email.toLowerCase(), password || null, clientId, refreshToken, password || null, clientId, refreshToken)
    );
    results.push({ email, status: "ok" });
  }

  if (stmts.length > 0) {
    try {
      await c.env.DB.batch(stmts);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "batch insert failed" }, 500);
    }
  }

  const success = results.filter((r) => r.status === "ok").length;
  return c.json({ ok: true, total: lines.length, success, results });
});

/** 编辑账号信息 */
accounts.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ email?: string; password?: string | null; expires_at?: string | null; client_id?: string | null; refresh_token?: string | null }>();

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

  if (fields.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(
    `UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  return c.json({ ok: true });
});

/** 用账号密码重新获取 refresh_token (ROPC) */
accounts.post("/:id/reauth", async (c) => {
  const id = c.req.param("id");
  const account = await c.env.DB.prepare(
    "SELECT id, email, password, client_id FROM accounts WHERE id = ?"
  ).bind(id).first<{ id: string; email: string; password: string | null; client_id: string | null }>();

  if (!account) return c.json({ error: "not found" }, 404);
  if (!account.password) return c.json({ error: "no password stored for this account" }, 400);
  if (!account.client_id) return c.json({ error: "no client_id stored for this account" }, 400);

  // 个人账号用 /consumers，企业账号用 /organizations
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
    "UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(token.access_token, token.refresh_token ?? "", expiresAt, id).run();

  return c.json({ ok: true, email: account.email });
});

/** 删除账号及其所有邮件 */
accounts.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM emails WHERE account_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

export default accounts;
