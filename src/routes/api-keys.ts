import { Hono } from "hono";
import type { Env } from "../types";
import { generateApiKey, requireJwt, type ApiKeyContext } from "../auth";

const VALID_SCOPES = new Set([
  "emails:read",
  "emails:send",
  "emails:delete",
  "accounts:read",
  "accounts:write",
  "*",
]);

const VALID_PROVIDERS = new Set(["domain", "gmail", "outlook"]);

const keys = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>();

// 所有 key 管理路由仅限 JWT
keys.use("*", requireJwt());

/** 列出所有 API key（不包含明文或 hash） */
keys.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, key_prefix, scopes, provider, expires_at, last_used_at, created_at FROM api_keys ORDER BY created_at DESC"
  ).all();
  return c.json({ keys: rows.results });
});

/** 创建 API key，明文仅在本次响应返回 */
keys.post("/", async (c) => {
  const body = await c.req.json<{
    name?: string;
    scopes?: string[];
    provider?: string | null;
    expires_at?: string | null;
  }>();

  const name = body.name?.trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const scopes = (body.scopes ?? []).filter((s) => VALID_SCOPES.has(s));
  if (scopes.length === 0) return c.json({ error: "at least one scope is required" }, 400);

  const provider = body.provider ?? null;
  if (provider !== null && !VALID_PROVIDERS.has(provider)) {
    return c.json({ error: "invalid provider" }, 400);
  }

  const expiresAt = body.expires_at ?? null;
  const { plaintext, hash, prefix } = await generateApiKey();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, provider, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, name, hash, prefix, scopes.join(","), provider, expiresAt).run();

  return c.json({
    ok: true,
    key: {
      id,
      name,
      key_prefix: prefix,
      scopes,
      provider,
      expires_at: expiresAt,
    },
    plaintext,
  }, 201);
});

/** 编辑 API key（不允许改 hash；可改 name/scopes/provider/expires_at） */
keys.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    scopes?: string[];
    provider?: string | null;
    expires_at?: string | null;
  }>();

  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: "name cannot be empty" }, 400);
    fields.push("name = ?");
    values.push(body.name.trim());
  }
  if (body.scopes !== undefined) {
    const scopes = body.scopes.filter((s) => VALID_SCOPES.has(s));
    if (scopes.length === 0) return c.json({ error: "at least one scope is required" }, 400);
    fields.push("scopes = ?");
    values.push(scopes.join(","));
  }
  if (body.provider !== undefined) {
    if (body.provider !== null && !VALID_PROVIDERS.has(body.provider)) {
      return c.json({ error: "invalid provider" }, 400);
    }
    fields.push("provider = ?");
    values.push(body.provider);
  }
  if (body.expires_at !== undefined) {
    fields.push("expires_at = ?");
    values.push(body.expires_at);
  }

  if (fields.length === 0) return c.json({ error: "no fields to update" }, 400);

  values.push(id);
  await c.env.DB.prepare(
    `UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  return c.json({ ok: true });
});

/** 撤销（删除）API key */
keys.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default keys;
