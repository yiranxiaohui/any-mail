import { Hono } from "hono";
import type { Env } from "../types";

const accounts = new Hono<{ Bindings: Env }>();

/** 列出邮箱账号（支持分页和搜索） */
accounts.get("/", async (c) => {
  const search = c.req.query("search");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");

  let sql = "SELECT id, provider, email, expires_at, created_at, updated_at FROM accounts";
  let countSql = "SELECT COUNT(*) as total FROM accounts";
  const params: string[] = [];
  const countParams: string[] = [];

  if (search) {
    sql += " WHERE email LIKE ?";
    countSql += " WHERE email LIKE ?";
    params.push(`%${search}%`);
    countParams.push(`%${search}%`);
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
    "SELECT id, provider, email, expires_at, created_at, updated_at FROM accounts WHERE id = ?"
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
    let clientId: string;
    let refreshToken: string;

    if (parts.length === 3) {
      // 格式: 邮箱----client_id----refresh_token
      [email, clientId, refreshToken] = parts as [string, string, string];
    } else {
      // 格式: 邮箱----密码----client_id----refresh_token
      email = parts[0]!;
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
        `INSERT INTO accounts (id, provider, email, client_id, refresh_token)
         VALUES (?, 'outlook', ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET client_id=?, refresh_token=?, updated_at=datetime('now')`
      ).bind(id, email.toLowerCase(), clientId, refreshToken, clientId, refreshToken)
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
  const body = await c.req.json<{ email?: string; expires_at?: string | null; client_id?: string | null; refresh_token?: string | null }>();

  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (body.email !== undefined) {
    fields.push("email = ?");
    values.push(body.email.trim().toLowerCase());
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
