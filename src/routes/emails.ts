import { Hono } from "hono";
import type { Env } from "../types";

const emails = new Hono<{ Bindings: Env }>();

/** 查询邮件列表 */
emails.get("/", async (c) => {
  const accountId = c.req.query("account_id");
  const to = c.req.query("to");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");

  let sql = "SELECT * FROM emails WHERE 1=1";
  const params: string[] = [];

  if (accountId) {
    sql += " AND account_id = ?";
    params.push(accountId);
  }
  if (to) {
    sql += " AND to_address LIKE ?";
    params.push(`%${to}%`);
  }

  sql += " ORDER BY received_at DESC LIMIT ? OFFSET ?";
  params.push(String(limit), String(offset));

  const result = await c.env.DB.prepare(sql)
    .bind(...params)
    .all();

  return c.json({ emails: result.results, meta: { limit, offset } });
});

/** 查询单封邮件 */
emails.get("/:id", async (c) => {
  const id = c.req.param("id");
  const email = await c.env.DB.prepare("SELECT * FROM emails WHERE id = ?")
    .bind(id)
    .first();

  if (!email) return c.json({ error: "not found" }, 404);
  return c.json(email);
});

/** 删除邮件 */
emails.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default emails;
