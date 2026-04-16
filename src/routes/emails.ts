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

/** 发送邮件（通过 Resend） */
emails.post("/send", async (c) => {
  const body = await c.req.json<{
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }>();

  if (!body.from || !body.to || !body.subject) {
    return c.json({ error: "from, to, subject are required" }, 400);
  }

  // 从 settings 读取 Resend API Key
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'RESEND_API_KEY'")
    .first<{ value: string }>();
  if (!row?.value) {
    return c.json({ error: "Resend API key not configured. Set it in Settings." }, 400);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${row.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: body.from,
      to: [body.to],
      subject: body.subject,
      text: body.text || undefined,
      html: body.html || undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: `Resend error: ${err}` }, 500);
  }

  const result = await res.json<{ id: string }>();

  // 保存到已发送记录
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO emails (id, account_id, message_id, provider, from_address, to_address, subject, text_body, html_body, raw_headers, received_at)
     VALUES (?, '', ?, 'resend', ?, ?, ?, ?, ?, '{}', datetime('now'))`
  ).bind(id, result.id, body.from, body.to, body.subject, body.text || "", body.html || "").run();

  return c.json({ ok: true, id: result.id });
});

/** 删除邮件 */
emails.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default emails;
