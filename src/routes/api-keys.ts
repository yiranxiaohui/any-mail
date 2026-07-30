import { Hono } from "hono";
import type { Env } from "../types";
import { generateApiKey, getUserId, type ApiKeyContext, type UserContext } from "../auth";

const VALID_SCOPES = new Set([
  "emails:read",
  "emails:send",
  "emails:delete",
  "accounts:read",
  "accounts:write",
  "domains:read",
  "keys:create",
  "*",
]);

const VALID_PROVIDERS = new Set(["domain", "gmail", "outlook"]);

const keys = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

// key 管理双模守卫:JWT 直接放行(全量权限);API key 必须显式带 keys:create。
// 注意 * 不隐含 keys:create —— 否则线上已有的 * key 会在部署后静默获得建 key 能力。
keys.use("*", async (c, next) => {
  const key = c.get("apiKey");
  if (key && !key.scopes.includes("keys:create")) {
    return c.json({ error: "api key requires the keys:create scope to manage keys" }, 403);
  }
  await next();
});

interface KeyLimits {
  scopes: string[];
  provider: string | null;
  address: string | null;
  expires_at: string | null;
}

/** 子集校验:子 key 权限必须 ⊆ 父 key(只收窄不放大)。通过返回 null,否则返回错误信息 */
function validateSubset(parent: KeyLimits, child: KeyLimits): string | null {
  const parentHasAll = parent.scopes.includes("*");
  for (const s of child.scopes) {
    if (!parentHasAll && !parent.scopes.includes(s)) {
      return `scope "${s}" exceeds parent key scopes`;
    }
    if (s === "*" && !parentHasAll) {
      return `scope "*" exceeds parent key scopes`;
    }
  }
  if (parent.provider !== null && child.provider !== parent.provider) {
    return "provider must match parent key provider";
  }
  if (parent.address !== null && (!child.address || !child.address.includes(parent.address))) {
    return "address must contain parent key address (narrowing only)";
  }
  if (parent.expires_at !== null) {
    const childMs = child.expires_at ? new Date(child.expires_at).getTime() : NaN;
    if (!child.expires_at || Number.isNaN(childMs) || childMs > new Date(parent.expires_at).getTime()) {
      return "expires_at is required and must not be later than parent key expires_at";
    }
  }
  return null;
}

const SELECT_KEYS = `SELECT k.id, k.name, k.key_prefix, k.scopes, k.provider, k.address,
    k.expires_at, k.last_used_at, k.created_at, k.created_by_key_id,
    p.key_prefix AS created_by_prefix
  FROM api_keys k LEFT JOIN api_keys p ON p.id = k.created_by_key_id`;

/** 列出 key:JWT 列出本用户全部;key 模式只列自己的直接子 key */
keys.get("/", async (c) => {
  const userId = getUserId(c);
  const apiKey = c.get("apiKey");
  const rows = apiKey
    ? await c.env.DB.prepare(`${SELECT_KEYS} WHERE k.created_by_key_id = ? ORDER BY k.created_at DESC`)
        .bind(apiKey.id).all()
    : await c.env.DB.prepare(`${SELECT_KEYS} WHERE k.user_id = ? ORDER BY k.created_at DESC`)
        .bind(userId).all();
  return c.json({ keys: rows.results });
});

/** 创建 API key,明文仅在本次响应返回;key 模式强制子集规则并写入血缘 */
keys.post("/", async (c) => {
  const userId = getUserId(c);
  const apiKey = c.get("apiKey");
  const body = await c.req.json<{
    name?: string;
    scopes?: string[];
    provider?: string | null;
    address?: string | null;
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

  const address = body.address?.trim() || null;
  const expiresAt = body.expires_at ?? null;
  if (expiresAt !== null && Number.isNaN(new Date(expiresAt).getTime())) {
    return c.json({ error: "invalid expires_at" }, 400);
  }

  if (apiKey) {
    const err = validateSubset(
      { scopes: apiKey.scopes, provider: apiKey.provider, address: apiKey.address, expires_at: apiKey.expires_at },
      { scopes, provider, address, expires_at: expiresAt },
    );
    if (err) return c.json({ error: err }, 400);
  }

  const { plaintext, hash, prefix } = await generateApiKey();
  const id = crypto.randomUUID();
  const createdByKeyId = apiKey?.id ?? null;

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes, provider, address, expires_at, created_by_key_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, name, hash, prefix, scopes.join(","), provider, address, expiresAt, createdByKeyId).run();

  return c.json({
    ok: true,
    key: {
      id,
      name,
      key_prefix: prefix,
      scopes,
      provider,
      address,
      expires_at: expiresAt,
      created_by_key_id: createdByKeyId,
    },
    plaintext,
  }, 201);
});

interface KeyRow {
  id: string;
  name: string;
  scopes: string;
  provider: string | null;
  address: string | null;
  expires_at: string | null;
  created_by_key_id: string | null;
}

/** 取目标 key;key 模式下目标必须是自己的直接子 key,否则视同不存在(404,防枚举) */
async function loadTargetKey(
  db: D1Database,
  id: string,
  userId: string,
  apiKey: ApiKeyContext | undefined,
): Promise<KeyRow | null> {
  const row = await db.prepare(
    "SELECT id, name, scopes, provider, address, expires_at, created_by_key_id FROM api_keys WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<KeyRow>();
  if (!row) return null;
  if (apiKey && row.created_by_key_id !== apiKey.id) return null;
  return row;
}

/** 编辑 API key(不允许改 hash);key 模式改动后仍须满足子集规则 */
keys.patch("/:id", async (c) => {
  const userId = getUserId(c);
  const apiKey = c.get("apiKey");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    scopes?: string[];
    provider?: string | null;
    address?: string | null;
    expires_at?: string | null;
  }>();

  const row = await loadTargetKey(c.env.DB, id, userId, apiKey);
  if (!row) return c.json({ error: "key not found" }, 404);

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
  if (body.address !== undefined) {
    fields.push("address = ?");
    values.push(body.address?.trim() || null);
  }
  if (body.expires_at !== undefined) {
    if (body.expires_at !== null && Number.isNaN(new Date(body.expires_at).getTime())) {
      return c.json({ error: "invalid expires_at" }, 400);
    }
    fields.push("expires_at = ?");
    values.push(body.expires_at);
  }

  if (fields.length === 0) return c.json({ error: "no fields to update" }, 400);

  if (apiKey) {
    const merged: KeyLimits = {
      scopes: body.scopes !== undefined
        ? body.scopes.filter((s) => VALID_SCOPES.has(s))
        : row.scopes.split(",").filter(Boolean),
      provider: body.provider !== undefined ? body.provider : row.provider,
      address: body.address !== undefined ? (body.address?.trim() || null) : row.address,
      expires_at: body.expires_at !== undefined ? body.expires_at : row.expires_at,
    };
    const err = validateSubset(
      { scopes: apiKey.scopes, provider: apiKey.provider, address: apiKey.address, expires_at: apiKey.expires_at },
      merged,
    );
    if (err) return c.json({ error: err }, 400);
  }

  values.push(id);
  values.push(userId);
  await c.env.DB.prepare(
    `UPDATE api_keys SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...values).run();

  return c.json({ ok: true });
});

/** 轮换 API key:生成新密文立即替换,旧密钥即刻失效;新明文仅本次响应返回 */
keys.post("/:id/rotate", async (c) => {
  const userId = getUserId(c);
  const apiKey = c.get("apiKey");
  const id = c.req.param("id");

  const row = await loadTargetKey(c.env.DB, id, userId, apiKey);
  if (!row) return c.json({ error: "key not found" }, 404);

  const { plaintext, hash, prefix } = await generateApiKey();
  await c.env.DB.prepare(
    "UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE id = ? AND user_id = ?"
  ).bind(hash, prefix, id, userId).run();

  return c.json({
    ok: true,
    key: {
      id: row.id,
      name: row.name,
      key_prefix: prefix,
      scopes: row.scopes.split(",").filter(Boolean),
      provider: row.provider,
      address: row.address,
      expires_at: row.expires_at,
    },
    plaintext,
  });
});

/** 撤销 API key:递归级联删除全部后代 key,不留孤儿(JWT 与 key 模式都级联) */
keys.delete("/:id", async (c) => {
  const userId = getUserId(c);
  const apiKey = c.get("apiKey");
  const id = c.req.param("id");

  const row = await loadTargetKey(c.env.DB, id, userId, apiKey);
  if (!row) return c.json({ error: "key not found" }, 404);

  await c.env.DB.prepare(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM api_keys WHERE id = ?
       UNION ALL
       SELECT k.id FROM api_keys k JOIN descendants d ON k.created_by_key_id = d.id
     )
     DELETE FROM api_keys WHERE id IN (SELECT id FROM descendants)`
  ).bind(id).run();

  return c.json({ ok: true });
});

export default keys;
