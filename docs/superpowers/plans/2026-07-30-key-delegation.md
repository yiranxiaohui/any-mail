# API Key 委派建 key(keys:create)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许持有 `keys:create` scope 的 API key 直接创建/管理自己派生的子 key(权限只收窄不放大),无需账号密码。

**Architecture:** `api_keys` 表加 `created_by_key_id` 血缘列;`/api/keys` 路由从 JWT-only 改为双模守卫(JWT 全量、key 模式仅限直接子 key + 子集校验);删除用递归 CTE 级联。前端 ApiKeys 页加 scope 勾选与来源徽章。

**Tech Stack:** Cloudflare Workers + Hono + D1(SQLite),React 19 + Vite,包管理用 bun。

**Spec:** `docs/superpowers/specs/2026-07-30-key-delegation-design.md`

## Global Constraints

- 项目无测试框架:验证方式为 `bunx tsc --noEmit`(后端)、`cd web && bunx tsc -b && bun run lint`(前端)、本地 `bun run dev` + curl 冒烟(Task 5)。
- **`*` scope 不隐含 `keys:create`**:key 访问 `/api/keys/*` 必须显式携带 `keys:create`。
- key 模式操作非自己直接子 key 的 id 一律返回 404(与「不存在」不可区分)。
- 子集规则违反返回 400,错误信息指明具体规则。
- 所有命令在 `/opt/any-mail` 下执行;不在服务器跑构建,本地只跑 typecheck/lint/dev。
- commit 尾注:
  ```
  Generated with [Claude Code](https://claude.ai/code)
  via [Happy](https://happy.engineering)

  Co-Authored-By: Claude <noreply@anthropic.com>
  Co-Authored-By: Happy <yesreply@happy.engineering>
  ```

---

### Task 1: 迁移 + auth.ts 类型扩展

**Files:**
- Create: `migrations/0014_key_lineage.sql`
- Modify: `src/auth.ts`(`Scope` 类型 :6-13、`ApiKeyContext` :15-21、`lookupApiKey` :227-247)

**Interfaces:**
- Produces: `api_keys.created_by_key_id` 列;`Scope` 联合类型新增 `"keys:create"`;`ApiKeyContext` 新增 `expires_at: string | null`(Task 2 的子集校验需要读父 key 的过期时间)。

- [ ] **Step 1: 写迁移文件**

`migrations/0014_key_lineage.sql`:

```sql
-- Key lineage: track which API key created this key (NULL = created by a JWT user).
-- No FK; cascade deletion is done in application code via recursive CTE.
ALTER TABLE api_keys ADD COLUMN created_by_key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_parent ON api_keys(created_by_key_id);
```

- [ ] **Step 2: 改 `src/auth.ts`**

`Scope` 类型加一行(在 `| "domains:read"` 之后):

```ts
  | "keys:create"
```

`ApiKeyContext` 接口加字段:

```ts
export interface ApiKeyContext {
  id: string;
  user_id: string;
  scopes: string[];
  provider: string | null;
  address: string | null;
  expires_at: string | null;
}
```

`lookupApiKey` 的 return 对象加 `expires_at: row.expires_at,`(`ApiKeyRow` 已含该字段,SELECT 已查出,无需改 SQL)。

- [ ] **Step 3: 本地跑迁移 + typecheck**

```bash
cd /opt/any-mail
bun run db:migrate:local
bunx tsc --noEmit
```

Expected: 迁移成功应用 0014;tsc 无错误。

- [ ] **Step 4: Commit**

```bash
git add migrations/0014_key_lineage.sql src/auth.ts
git commit -m "feat(keys): api_keys 加 created_by_key_id 血缘列,keys:create scope 类型"
```

---

### Task 2: 后端路由改造(双模守卫 + 子集校验 + 血缘 + 级联删除)

**Files:**
- Modify: `src/routes/api-keys.ts`(整文件重写)

**Interfaces:**
- Consumes: Task 1 的 `ApiKeyContext.expires_at`、`created_by_key_id` 列。
- Produces: `GET /api/keys` 响应每行多两个字段 `created_by_key_id: string | null`、`created_by_prefix: string | null`(Task 4 前端依赖);key 模式的五个端点行为(Task 3 文档、Task 5 验证依赖)。

- [ ] **Step 1: 重写 `src/routes/api-keys.ts`**

完整新文件内容:

```ts
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
    if (!child.expires_at || new Date(child.expires_at).getTime() > new Date(parent.expires_at).getTime()) {
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
```

要点(相对旧文件的行为差异):
- 移除 `requireJwt` 的引入与使用(`requireJwt` 在 `src/index.ts` 里仍被别的路由用,不要动 auth.ts 导出)。
- 守卫改为显式 `keys.use("*", ...)` 匿名中间件。
- DELETE 从单行 `DELETE ... WHERE id AND user_id` 改为先 `loadTargetKey`(404 语义)再递归 CTE 级联。
- 旧 PATCH/DELETE 对不存在的 id 静默返回 ok;新代码统一 404。这是有意的行为收紧。

- [ ] **Step 2: Typecheck**

```bash
cd /opt/any-mail && bunx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: 快速冒烟(仅验证路由能跑,完整链路在 Task 5)**

```bash
cd /opt/any-mail
[ -f .dev.vars ] || printf 'JWT_SECRET=dev-secret\n' > .dev.vars
(bun run dev &>/tmp/anymail-dev.log &) && sleep 5
curl -s http://127.0.0.1:8787/api/keys -H "Authorization: Bearer ak_bogus" | head -c 200
kill %1 2>/dev/null; pkill -f "wrangler dev" 2>/dev/null
```

Expected: 返回 `{"error":"invalid or expired api key"}`(说明路由链活着且 key 走到了 lookup)。

- [ ] **Step 4: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat(keys): API key 可用 keys:create scope 委派创建/管理子 key,删除递归级联"
```

---

### Task 3: 更新 docs/API.md

**Files:**
- Modify: `docs/API.md`(第 16 行 key 说明、~1020 行 `/api/keys` 章节、~1218-1221 端点总表)

**Interfaces:**
- Consumes: Task 2 的端点行为与错误语义。

- [ ] **Step 1: 改写 key 管理章节**

先读 `docs/API.md` 的 1010-1140 行确认现状,然后:

1. 第 16 行的 API key 说明句尾补充:scopes 列表中加入 `keys:create`。
2. 把 `> All /api/keys endpoints are **JWT-only** ...` 这条 blockquote 替换为:

```markdown
> `/api/keys` endpoints accept **JWT** (full access to all of the user's keys) or an **API key that explicitly carries the `keys:create` scope**. Note `*` does NOT imply `keys:create` — the scope must be listed explicitly.
>
> **Key-mode restrictions (delegation):**
> - Visibility is limited to keys the calling key created (`created_by_key_id` = caller). Operating on any other id returns 404.
> - A key can never read/modify/rotate/delete itself.
> - Created/edited child keys must be a **subset** of the parent key (privileges only narrow):
>   - every child scope must appear in the parent's scopes (or parent has `*`);
>   - if the parent has a `provider`, the child's must equal it;
>   - if the parent has an `address`, the child's must be non-empty and contain the parent's as a substring;
>   - if the parent has an `expires_at`, the child must set one no later than it.
>   Violations return 400 with the failed rule.
> - `DELETE /api/keys/:id` cascades: all descendant keys (children, grandchildren, …) are deleted recursively. This applies in JWT mode too.
```

3. `GET /api/keys` 的响应示例字段中加入 `"created_by_key_id": null` 与 `"created_by_prefix": null`,并注明:非 null 时表示该 key 由另一把 key 创建,`created_by_prefix` 是父 key 的前缀(父已删则为 null)。
4. `POST /api/keys` 的响应示例 `key` 对象中加入 `"created_by_key_id": null`。
5. 端点总表(~1218-1221 行)四行的说明从 `(JWT only)` 改为 `(JWT or key with keys:create)`,并给 DELETE 行注明 `cascades to descendants`。

- [ ] **Step 2: Commit**

```bash
git add docs/API.md
git commit -m "docs(api): keys:create 委派建 key 的端点行为、子集规则与级联语义"
```

---

### Task 4: 前端(scope 勾选 + 来源徽章 + i18n)

**Files:**
- Modify: `web/src/lib/api.ts:354-364`(`ApiKey` 接口)
- Modify: `web/src/pages/ApiKeys.tsx`(`ALL_SCOPES` :11、scope 勾选区 :182-200、列表徽章 :300-313)
- Modify: `web/src/locales/en.json`、`web/src/locales/zh.json`(`apiKeys` 命名空间)

**Interfaces:**
- Consumes: Task 2 的 `GET /api/keys` 新字段 `created_by_key_id` / `created_by_prefix`。

- [ ] **Step 1: `web/src/lib/api.ts` 的 `ApiKey` 接口加字段**

```ts
  created_by_key_id: string | null;   // non-null = created by another API key (delegation)
  created_by_prefix: string | null;   // parent key's prefix for display; null if parent deleted
```

- [ ] **Step 2: `web/src/pages/ApiKeys.tsx`**

1. `ALL_SCOPES` 加 `"keys:create"`:

```ts
const ALL_SCOPES = ["emails:read", "emails:send", "emails:delete", "accounts:read", "accounts:write", "domains:read", "keys:create"] as const;
```

2. scope 勾选按钮组的 `</div>`(:199)之后、外层 `space-y-1.5` div 内,加条件提示:

```tsx
{scopes.includes("keys:create") && (
  <p className="text-xs text-muted-foreground">{t("apiKeys.keysCreateHint")}</p>
)}
```

3. 列表行里 `{key.address && (...)}` 徽章(:308-312)之后,加来源徽章:

```tsx
{key.created_by_key_id && (
  <span className="text-xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
    {key.created_by_prefix
      ? t("apiKeys.createdByKey", { prefix: key.created_by_prefix })
      : t("apiKeys.createdByDeletedKey")}
  </span>
)}
```

- [ ] **Step 3: i18n 文案**

`en.json` 的 `apiKeys.scopeLabels` 加 `"keys_create": "Create child keys"`(i18n 里 scope 的 `:` 存成 `_`,`scopeLabelKey` 函数已自动转换);`apiKeys` 下加:

```json
"keysCreateHint": "Allows this key to create and manage child keys via the API. Child key privileges can only narrow, never expand.",
"createdByKey": "Created by {{prefix}}…",
"createdByDeletedKey": "Created by a deleted key"
```

`zh.json` 对应:`"keys_create": "创建子 key"` 与

```json
"keysCreateHint": "允许该 key 通过 API 创建并管理子 key。子 key 权限只能收窄,不能放大。",
"createdByKey": "由 {{prefix}}… 创建",
"createdByDeletedKey": "由已删除的 key 创建"
```

- [ ] **Step 4: Typecheck + lint**

```bash
cd /opt/any-mail/web && bunx tsc -b && bun run lint
```

Expected: 均通过(lint 允许存在与本次改动无关的既有 warning,不新增 error)。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/pages/ApiKeys.tsx web/src/locales/en.json web/src/locales/zh.json
git commit -m "feat(web): API key 页支持 keys:create scope 勾选与子 key 来源徽章"
```

---

### Task 5: 端到端 curl 验证

**Files:** 无代码改动;临时脚本放 scratchpad,不入库。

**Interfaces:**
- Consumes: Task 1-4 全部产出。

- [ ] **Step 1: 起本地环境**

```bash
cd /opt/any-mail
[ -f .dev.vars ] || printf 'JWT_SECRET=dev-secret\n' > .dev.vars
bun run db:migrate:local
bun run dev &>/tmp/anymail-dev.log &
sleep 6 && curl -s http://127.0.0.1:8787/api/domains -o /dev/null -w '%{http_code}\n'
```

Expected: 最后输出 HTTP 状态码(200 或 401 都说明服务活着)。

- [ ] **Step 2: 注册用户拿 JWT,建父 key**

```bash
B=http://127.0.0.1:8787
TOKEN=$(curl -s $B/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"keytest@example.com","password":"keytest123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 父 key:emails:read + keys:create,限 domain / @test.com / 2030 年过期
PARENT=$(curl -s $B/api/keys -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"parent","scopes":["emails:read","keys:create"],"provider":"domain","address":"@test.com","expires_at":"2030-01-01T00:00:00Z"}')
echo "$PARENT" | python3 -m json.tool
PK=$(echo "$PARENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["plaintext"])')

# 对照 key:只有 * ,没有 keys:create
STAR=$(curl -s $B/api/keys -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"star","scopes":["*"]}')
SK=$(echo "$STAR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["plaintext"])')
```

Expected: 两次创建均 `"ok": true`,父 key 响应含 `"created_by_key_id": null`。

- [ ] **Step 3: 正向链路——key 建 key、列表、级联删除**

```bash
# 1) 父 key 建合法子 key(全部收窄)→ 201
CHILD=$(curl -s $B/api/keys -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' \
  -d '{"name":"child","scopes":["emails:read","keys:create"],"provider":"domain","address":"x@test.com","expires_at":"2029-01-01T00:00:00Z"}')
echo "$CHILD" | python3 -m json.tool   # created_by_key_id = 父 key 的 id
CK=$(echo "$CHILD" | python3 -c 'import sys,json;print(json.load(sys.stdin)["plaintext"])')
CID=$(echo "$CHILD" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"]["id"])')

# 2) 子 key 再建孙 key(链式委派)→ 201
curl -s $B/api/keys -H "Authorization: Bearer $CK" -H 'Content-Type: application/json' \
  -d '{"name":"grandchild","scopes":["emails:read"],"provider":"domain","address":"x@test.com","expires_at":"2028-01-01T00:00:00Z"}' | python3 -m json.tool

# 3) 父 key GET 列表 → 只看到 child 一条(看不到 star,也看不到 grandchild)
curl -s $B/api/keys -H "Authorization: Bearer $PK" | python3 -m json.tool

# 4) JWT 删除父 key → 级联
PID=$(echo "$PARENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"]["id"])')
curl -s -X DELETE $B/api/keys/$PID -H "Authorization: Bearer $TOKEN"
# 5) JWT 列表:parent/child/grandchild 全消失,只剩 star
curl -s $B/api/keys -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# 6) 旧子 key 立即失效 → 401
curl -s -o /dev/null -w '%{http_code}\n' $B/api/emails -H "Authorization: Bearer $CK"
```

Expected: 按注释逐条成立;最后一条输出 `401`。

- [ ] **Step 4: 越权用例(重建父/子后逐条打)**

先用 Step 2/3 的命令重建 `PK`/`CK`/`CID`,然后:

```bash
run() { echo "-- $1"; shift; "$@"; echo; }

# 无 keys:create 的 *-key 访问管理接口 → 403
run "star key list -> 403" curl -s -w ' [%{http_code}]' $B/api/keys -H "Authorization: Bearer $SK"
# 子 scope 超父 → 400
run "scope escalation -> 400" curl -s -w ' [%{http_code}]' $B/api/keys -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' \
  -d '{"name":"bad","scopes":["emails:send"],"provider":"domain","address":"x@test.com","expires_at":"2029-01-01T00:00:00Z"}'
# provider 放大 → 400
run "provider widen -> 400" curl -s -w ' [%{http_code}]' $B/api/keys -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' \
  -d '{"name":"bad","scopes":["emails:read"],"provider":"gmail","address":"x@test.com","expires_at":"2029-01-01T00:00:00Z"}'
# address 未收窄 → 400
run "address widen -> 400" curl -s -w ' [%{http_code}]' $B/api/keys -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' \
  -d '{"name":"bad","scopes":["emails:read"],"provider":"domain","address":"@other.com","expires_at":"2029-01-01T00:00:00Z"}'
# 不带 expires → 400
run "no expiry -> 400" curl -s -w ' [%{http_code}]' $B/api/keys -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' \
  -d '{"name":"bad","scopes":["emails:read"],"provider":"domain","address":"x@test.com"}'
# PATCH 子 key 把 scope 改超父 → 400
run "patch escalation -> 400" curl -s -w ' [%{http_code}]' -X PATCH $B/api/keys/$CID -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' \
  -d '{"scopes":["emails:delete"]}'
# 操作非子 key(star 的 id)→ 404
SID=$(echo "$STAR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"]["id"])')
run "foreign key id -> 404" curl -s -w ' [%{http_code}]' -X DELETE $B/api/keys/$SID -H "Authorization: Bearer $PK"
# 操作自己 → 404
PID2=$(curl -s $B/api/keys -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json;ks=json.load(sys.stdin)["keys"];print([k["id"] for k in ks if k["name"]=="parent"][0])')
run "self delete -> 404" curl -s -w ' [%{http_code}]' -X DELETE $B/api/keys/$PID2 -H "Authorization: Bearer $PK"
```

Expected: 状态码逐条为 403 / 400×5 / 404 / 404,错误 message 指明对应规则。

- [ ] **Step 5: 清理 + 收尾**

```bash
pkill -f "wrangler dev" 2>/dev/null
cd /opt/any-mail && git status --short   # 应无未提交改动(.dev.vars 在 .gitignore)
```

若发现任何用例不符,回到对应 Task 修复后重跑本 Task。全部通过后本计划完成(部署 `bun run deploy` + `db:migrate:remote` 由用户决定,不在本计划内)。
