import { Hono } from "hono";
import type { Env } from "../types";
import { requireScope, type ApiKeyContext } from "../auth";

const emails = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>();

/** 查询邮件列表 */
emails.get("/", requireScope("emails:read"), async (c) => {
  const accountId = c.req.query("account_id");
  const providerQuery = c.req.query("provider");
  const to = c.req.query("to");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");

  // API key 限定 provider 时，覆盖用户传入的 provider
  const keyProvider = c.get("apiKey")?.provider ?? null;
  const provider = keyProvider ?? providerQuery;

  let sql = "SELECT * FROM emails WHERE 1=1";
  let countSql = "SELECT COUNT(*) as total FROM emails WHERE 1=1";
  const params: string[] = [];
  const countParams: string[] = [];

  if (accountId) {
    sql += " AND account_id = ?";
    countSql += " AND account_id = ?";
    params.push(accountId);
    countParams.push(accountId);
  }
  if (provider) {
    sql += " AND provider = ?";
    countSql += " AND provider = ?";
    params.push(provider);
    countParams.push(provider);
  }
  if (to) {
    sql += " AND to_address LIKE ?";
    countSql += " AND to_address LIKE ?";
    params.push(`%${to}%`);
    countParams.push(`%${to}%`);
  }

  sql += " ORDER BY received_at DESC LIMIT ? OFFSET ?";
  params.push(String(limit), String(offset));

  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(sql).bind(...params),
    c.env.DB.prepare(countSql).bind(...countParams),
  ]);

  const rows = batchResults[0]?.results ?? [];
  const total = (batchResults[1]?.results[0] as { total: number })?.total ?? 0;

  return c.json({ emails: rows, meta: { limit, offset, total } });
});

/** 接码专用：按收件人过滤拉取最新邮件（含可选正则提取验证码） */
emails.get("/latest", requireScope("emails:read"), async (c) => {
  const to = c.req.query("to");
  const since = c.req.query("since");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);
  const codeRegex = c.req.query("code_regex");

  const keyProvider = c.get("apiKey")?.provider ?? null;

  let sql = "SELECT * FROM emails WHERE 1=1";
  const params: string[] = [];

  if (to) {
    sql += " AND to_address LIKE ?";
    params.push(`%${to}%`);
  }
  if (since) {
    sql += " AND received_at > ?";
    params.push(since);
  }
  if (keyProvider) {
    sql += " AND provider = ?";
    params.push(keyProvider);
  }
  sql += " ORDER BY received_at DESC LIMIT ?";
  params.push(String(limit));

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  let results = rows.results as Array<Record<string, unknown>>;

  if (codeRegex) {
    let re: RegExp;
    try {
      re = new RegExp(codeRegex);
    } catch {
      return c.json({ error: "invalid code_regex" }, 400);
    }
    results = results.map((r) => {
      const text = String(r.text_body ?? "");
      const html = String(r.html_body ?? "");
      const subject = String(r.subject ?? "");
      const match = text.match(re) ?? html.match(re) ?? subject.match(re);
      return { ...r, code: match ? match[1] ?? match[0] : null };
    });
  }

  return c.json({ emails: results });
});

/** 查询单封邮件 */
emails.get("/:id", requireScope("emails:read"), async (c) => {
  const id = c.req.param("id");
  const keyProvider = c.get("apiKey")?.provider ?? null;

  const email = await c.env.DB.prepare("SELECT * FROM emails WHERE id = ?")
    .bind(id)
    .first<{ provider: string }>();

  if (!email) return c.json({ error: "not found" }, 404);
  if (keyProvider && email.provider !== keyProvider) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(email);
});

/** 发送邮件（通过 Resend） */
emails.post("/send", requireScope("emails:send"), async (c) => {
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
emails.delete("/:id", requireScope("emails:delete"), async (c) => {
  const id = c.req.param("id");
  const keyProvider = c.get("apiKey")?.provider ?? null;

  if (keyProvider) {
    const row = await c.env.DB.prepare("SELECT provider FROM emails WHERE id = ?")
      .bind(id).first<{ provider: string }>();
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.provider !== keyProvider) return c.json({ error: "not found" }, 404);
  }

  await c.env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default emails;
