import { Hono } from "hono";
import type { Env } from "../types";

const accounts = new Hono<{ Bindings: Env }>();

/** 列出所有绑定的邮箱账号 */
accounts.get("/", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, provider, email, created_at, updated_at FROM accounts ORDER BY created_at DESC"
  ).all();
  return c.json({ accounts: result.results });
});

/** 查询单个账号 */
accounts.get("/:id", async (c) => {
  const id = c.req.param("id");
  const account = await c.env.DB.prepare(
    "SELECT id, provider, email, created_at, updated_at FROM accounts WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!account) return c.json({ error: "not found" }, 404);
  return c.json(account);
});

/** 创建域名邮箱账号 */
accounts.post("/", async (c) => {
  const body = await c.req.json<{ email: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid email" }, 400);
  }

  // 检查是否已存在
  const existing = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE email = ? AND provider = 'domain'"
  ).bind(email).first();
  if (existing) {
    return c.json({ error: "account already exists" }, 409);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO accounts (id, provider, email) VALUES (?, 'domain', ?)"
  ).bind(id, email).run();

  return c.json({ ok: true, account: { id, provider: "domain", email } }, 201);
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
