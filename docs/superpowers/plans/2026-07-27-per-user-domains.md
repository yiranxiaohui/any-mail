# 域名管理按用户化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除全局 EMAIL_DOMAINS，`user_domains` 表成为域名归属唯一来源；域名管理 UI 全部收敛到「我的域名」页。

**Architecture:** 一条幂等 SQL 迁移把 settings.EMAIL_DOMAINS 拆进 user_domains（归属 admin）；后端所有读取方改查 user_domains；settings.ts 里的域名端点（guide/check-mx/import/sync）搬到 /api/user-domains 命名空间并写入当前用户；前端 Settings.tsx 删掉两张域名卡片，Domains.tsx 迁入导入向导与同步按钮。

**Tech Stack:** Cloudflare Workers + Hono + D1（SQLite）后端；React 19 + Vite 前端；bun/bunx 工具链。

**Spec:** `docs/superpowers/specs/2026-07-27-per-user-domains-design.md`

## Global Constraints

- 无测试框架，不新增。验证方式：`bunx tsc --noEmit`（根目录）、`cd web && bunx tsc -b`（前端）、`bunx wrangler d1 execute any-mail-db --local ...` 查数据、必要时 `bun run dev` + curl。
- 包管理只用 bun/bunx；不跑 `bun run build`、`vite build` 等打包命令（用户规约：本地不打包）。
- 不改动：SHARED_INBOX_DOMAIN 逻辑、收信 worker（`src/providers/domain.ts`）、API key `domains:read` scope 语义。
- `GET /api/domains` 响应结构保持 `{ domains: { name: string }[] }`（外部 API key 客户端兼容）。
- 前端复用现有 `settings.*` i18n key（i18n key 是全局的，Domains 页可直接用），不新增翻译。
- shadcn/ui 是 @base-ui/react 变体：Button 无 `asChild`。
- 提交信息结尾带：
  ```
  Generated with [Claude Code](https://claude.ai/code)
  via [Happy](https://happy.engineering)

  Co-Authored-By: Claude <noreply@anthropic.com>
  Co-Authored-By: Happy <yesreply@happy.engineering>
  ```

---

### Task 1: 迁移 0013 — 全局域名迁入 user_domains

**Files:**
- Create: `migrations/0013_migrate_global_domains.sql`

**Interfaces:**
- Produces: 迁移后 `user_domains` 含原 EMAIL_DOMAINS 全部域名（归属 admin 用户），`settings` 无 `EMAIL_DOMAINS` 行。后续任务假设该状态。

- [ ] **Step 1: 准备本地 DB 并造测试数据**

```bash
cd /opt/any-mail
bun run db:migrate:local
bunx wrangler d1 execute any-mail-db --local --command "INSERT INTO settings (key, value, updated_at) VALUES ('EMAIL_DOMAINS', 'a.test, B.test ,a.test,', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
```

Expected: 两条命令成功。测试值故意含空白、大写、重复、尾逗号。

- [ ] **Step 2: 写迁移文件**

创建 `migrations/0013_migrate_global_domains.sql`：

```sql
-- Migrate the admin-managed global EMAIL_DOMAINS list into per-user user_domains
-- (owned by the admin user), then drop the setting. user_domains becomes the single
-- source of truth for domain ownership. Idempotent: OR IGNORE + DELETE.
INSERT OR IGNORE INTO user_domains (user_id, domain_name)
WITH RECURSIVE split(rest, dom) AS (
  SELECT COALESCE((SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'), '') || ',', ''
  UNION ALL
  SELECT substr(rest, instr(rest, ',') + 1), substr(rest, 1, instr(rest, ',') - 1)
  FROM split WHERE rest <> ''
)
SELECT COALESCE((SELECT id FROM users WHERE role = 'admin' LIMIT 1), 'admin'), lower(trim(dom))
FROM split WHERE trim(dom) <> '';

DELETE FROM settings WHERE key = 'EMAIL_DOMAINS';
```

- [ ] **Step 3: 执行迁移并验证**

```bash
bunx wrangler d1 execute any-mail-db --local --file=migrations/0013_migrate_global_domains.sql
bunx wrangler d1 execute any-mail-db --local --command "SELECT user_id, domain_name FROM user_domains WHERE domain_name LIKE '%.test' ORDER BY domain_name"
bunx wrangler d1 execute any-mail-db --local --command "SELECT COUNT(*) AS n FROM settings WHERE key = 'EMAIL_DOMAINS'"
```

Expected: user_domains 出现 `a.test`、`b.test` 各一条且 user_id 为 admin 用户 id（bootstrap 值 `admin`）；settings 计数为 0。

- [ ] **Step 4: 验证幂等**

```bash
bunx wrangler d1 execute any-mail-db --local --file=migrations/0013_migrate_global_domains.sql
```

Expected: 成功、无报错、数据不变（EMAIL_DOMAINS 已删，CTE 种子为空串，不再插入）。

- [ ] **Step 5: 清理测试数据并提交**

```bash
bunx wrangler d1 execute any-mail-db --local --command "DELETE FROM user_domains WHERE domain_name LIKE '%.test'"
git add migrations/0013_migrate_global_domains.sql
git commit -m "feat(db): 迁移全局 EMAIL_DOMAINS 至 admin 的 user_domains"
```

（提交信息按 Global Constraints 加尾部署名，下同。）

---

### Task 2: 后端读取方收敛到 user_domains

**Files:**
- Modify: `src/index.ts:68-76`（`GET /api/domains`）
- Modify: `src/routes/accounts.ts:201-211`（建账号域名校验）
- Modify: `src/routes/settings.ts:420-432`（删除 `GET /domains` 可用域名接口）

**Interfaces:**
- Consumes: Task 1 后 user_domains 为唯一来源。
- Produces: `GET /api/domains` 返回当前用户（JWT 或 API key 所属用户）的 `{ domains: { name: string }[] }`；`GET /api/settings/domains` 不复存在（404）。Task 4 的前端 `getDomains()` 依赖前者。

- [ ] **Step 1: 改写 `GET /api/domains`（src/index.ts）**

把现有实现（读 settings.EMAIL_DOMAINS）整体替换为：

```ts
// 当前用户可用域名（JWT 或 API key 均按所属用户返回；API key 需 domains:read）
app.get("/api/domains", requireScope("domains:read"), async (c) => {
  const userId = getUserId(c);
  const rows = await c.env.DB.prepare(
    "SELECT domain_name FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string }>();
  return c.json({ domains: rows.results.map((r) => ({ name: r.domain_name })) });
});
```

`getUserId` 已在 index.ts 中 import（`/api/sync` 在用），无需新增 import。

- [ ] **Step 2: 改写建账号域名校验（src/routes/accounts.ts）**

将 201-211 行的 batch 查询 + `inGlobal`/`inOwned` 合并逻辑替换为：

```ts
  // 校验域名归属：仅认该用户在 user_domains 里声明的
  const owned = await c.env.DB.prepare(
    "SELECT 1 FROM user_domains WHERE user_id = ? AND domain_name = ?"
  ).bind(userId, domain).first();
  if (!owned) {
    return c.json({ error: `domain ${domain} is not available. Add it under "My Domains" first.` }, 403);
  }
```

- [ ] **Step 3: 删除 `settings.get("/domains", ...)`**

删除 `src/routes/settings.ts` 420-432 行整个 handler（含注释）。

- [ ] **Step 4: 类型检查**

Run: `cd /opt/any-mail && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/routes/accounts.ts src/routes/settings.ts
git commit -m "feat(api): 域名可用性只认 user_domains"
```

---

### Task 3: 域名端点迁至 /api/user-domains，写入当前用户

**Files:**
- Modify: `src/routes/user-domains.ts`（新增 guide/check-mx/import/sync 四个端点；删除声明时的全局列表检查）
- Modify: `src/routes/settings.ts`（删除 `/domains/guide`、`/domains/check-mx`、`/domains/auto-enable`、`/domains/import`、`/domains/sync` 五个 handler；SYSTEM_KEYS 移除 `EMAIL_DOMAINS`；删除因此不再使用的 import）

**Interfaces:**
- Consumes: Task 1/2 的数据状态。
- Produces（Task 4 前端依赖，响应结构与旧端点一致）:
  - `GET /api/user-domains/guide` → MxGuide（同旧 `/api/settings/domains/guide`）
  - `POST /api/user-domains/check-mx` `{domain}` → MxCheckResult
  - `POST /api/user-domains/import` `{domain, force?, auto_enable?, create_zone?}` → DomainImportResult，`scope` 恒为 `"user"`，`domains` 为本人域名列表
  - `POST /api/user-domains/sync`（admin only）→ `{ ok: true, domains: string[] }`

- [ ] **Step 1: 扩展 user-domains.ts**

改写 `src/routes/user-domains.ts` 为以下内容（保留原有 GET `/`、POST `/`、DELETE `/:name`，其中 POST `/` 删除「与全局 EMAIL_DOMAINS 重合禁止」段，保留 SHARED_INBOX_DOMAIN 检查）：

```ts
import { Hono } from "hono";
import type { Env } from "../types";
import { requireJwt, requireAdmin, getUserId, type ApiKeyContext, type UserContext } from "../auth";
import { checkDomainMx, getMxGuide, normalizeDomain } from "../dns";
import { autoEnableEmailRouting, getCloudflareCredentials } from "../cloudflare";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const userDomains = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

userDomains.use("*", requireJwt());

/** 声明域名归属并返回本人全部域名（调用前需自行确认未被他人占用） */
async function claimDomain(db: D1Database, userId: string, name: string): Promise<string[]> {
  await db.prepare("INSERT OR IGNORE INTO user_domains (user_id, domain_name) VALUES (?, ?)")
    .bind(userId, name).run();
  const owned = await db.prepare(
    "SELECT domain_name FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string }>();
  return owned.results.map((r) => r.domain_name);
}

/** 归属冲突 / 共享域名检查；返回 null 表示可声明，否则返回错误响应 */
async function checkClaimable(c: { env: Env }, userId: string, name: string): Promise<{ error: string; status: 409 } | null> {
  const claimed = await c.env.DB.prepare("SELECT user_id FROM user_domains WHERE domain_name = ?")
    .bind(name).first<{ user_id: string }>();
  if (claimed && claimed.user_id !== userId) {
    return { error: "domain already claimed by another user", status: 409 };
  }
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'SHARED_INBOX_DOMAIN'")
    .first<{ value: string }>();
  const sharedDomain = (row?.value ?? "").trim().toLowerCase();
  if (sharedDomain && sharedDomain === name) {
    return { error: "this is the shared inbox domain and cannot be claimed", status: 409 };
  }
  return null;
}

/** 列出当前用户已声明的域名 */
userDomains.get("/", async (c) => {
  const userId = getUserId(c);
  const rows = await c.env.DB.prepare(
    "SELECT domain_name, created_at FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string; created_at: string }>();
  return c.json({ domains: rows.results });
});

/** 域名接入指引：所需 MX / SPF 与操作步骤 */
userDomains.get("/guide", async (c) => {
  return c.json(getMxGuide());
});

/** 检测域名 MX 是否已指向 Cloudflare Email Routing */
userDomains.post("/check-mx", async (c) => {
  const body = await c.req.json<{ domain?: string }>().catch(() => ({} as { domain?: string }));
  const domain = body.domain?.trim();
  if (!domain) return c.json({ error: "domain required" }, 400);

  try {
    const result = await checkDomainMx(domain);
    return c.json(result);
  } catch (err) {
    return c.json(
      {
        domain: normalizeDomain(domain) ?? domain,
        ok: false,
        records: [],
        matched: [],
        missing: [],
        extra: [],
        message: "dns_error",
        error: err instanceof Error ? err.message : "DNS lookup failed",
      },
      502
    );
  }
});

/**
 * 导入域名并尽量自动启用收信，结果写入当前用户的 user_domains：
 * - admin + 有 CF 凭据 + auto_enable：必要时创建 Zone，Email Routing + catch-all → Worker
 *   （Zone 未 active 时返回 pending_ns + nameservers）
 * - 其余：仅 MX 检测后写入（force 可跳过 MX）
 */
userDomains.post("/import", async (c) => {
  const body = await c.req
    .json<{ domain?: string; force?: boolean; auto_enable?: boolean; create_zone?: boolean }>()
    .catch(() => ({} as { domain?: string; force?: boolean; auto_enable?: boolean; create_zone?: boolean }));
  const raw = body.domain?.trim();
  if (!raw) return c.json({ error: "domain required" }, 400);

  const domain = normalizeDomain(raw);
  if (!domain) return c.json({ error: "invalid domain" }, 400);

  const user = c.get("user")!;
  const userId = getUserId(c);

  const conflict = await checkClaimable(c, userId, domain);
  if (conflict) return c.json({ error: conflict.error }, conflict.status);

  // admin 默认自动启用（有 CF 凭据时）
  if (user.role === "admin" && body.auto_enable !== false) {
    const creds = await getCloudflareCredentials(c.env);
    if (creds) {
      const enable = await autoEnableEmailRouting(domain, creds, {
        createIfMissing: body.create_zone !== false,
      });
      if (!enable.ok) {
        return c.json({
          ok: false,
          error: enable.error ?? "auto_enable_failed",
          domain: enable.domain,
          zone_id: enable.zone_id,
          zone_status: enable.zone_status,
          nameservers: enable.nameservers,
          pending_ns: enable.pending_ns,
          zone_created: enable.zone_created,
          worker: enable.worker,
          steps: enable.steps,
        });
      }

      let mx = null as Awaited<ReturnType<typeof checkDomainMx>> | null;
      try {
        mx = await checkDomainMx(domain);
      } catch {
        mx = null;
      }

      const domains = await claimDomain(c.env.DB, userId, domain);
      return c.json({
        ok: true,
        domain,
        mx,
        forced: false,
        enabled: true,
        auto_enabled: true,
        scope: "user",
        domains,
        steps: enable.steps,
        worker: enable.worker,
        zone_id: enable.zone_id,
        zone_status: enable.zone_status,
        nameservers: enable.nameservers,
        zone_created: enable.zone_created,
      });
    }
  }

  // 无 CF 自动启用：走 MX 检测后写入
  let mx;
  try {
    mx = await checkDomainMx(raw);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : "DNS lookup failed",
        message: "dns_error",
      },
      502
    );
  }

  if (mx.message === "invalid domain") {
    return c.json({ error: "invalid domain" }, 400);
  }

  if (!mx.ok && !body.force) {
    return c.json({ error: "mx_not_ready", message: mx.message, mx }, 400);
  }

  const domains = await claimDomain(c.env.DB, userId, mx.domain);
  return c.json({
    ok: true,
    domain: mx.domain,
    mx,
    forced: !mx.ok && !!body.force,
    auto_enabled: false,
    scope: "user",
    domains,
  });
});

/** 从 Cloudflare API 同步主账号 Zone 域名到自己的 user_domains — admin only */
userDomains.post("/sync", requireAdmin(), async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID')"
  ).all<{ key: string; value: string }>();

  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const apiToken = c.env.CLOUDFLARE_API_TOKEN || map.get("CLOUDFLARE_API_TOKEN");
  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID || map.get("CLOUDFLARE_ACCOUNT_ID");

  if (!apiToken || !accountId) {
    return c.json({ error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required." }, 400);
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  const data = await res.json() as {
    success: boolean;
    result?: { id: string; name: string }[];
    errors?: { message: string }[];
  };

  if (!data.success) {
    return c.json({ error: data.errors?.[0]?.message || "Failed to fetch domains" }, 500);
  }

  const allDomains: string[] = [];
  for (const zone of data.result ?? []) {
    allDomains.push(zone.name);
    try {
      const dnsRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records?type=MX&per_page=100`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      const dnsData = await dnsRes.json() as { success: boolean; result?: { name: string }[] };
      if (dnsData.success && dnsData.result) {
        for (const record of dnsData.result) {
          if (record.name !== zone.name && !allDomains.includes(record.name)) {
            allDomains.push(record.name);
          }
        }
      }
    } catch {}
  }

  const userId = getUserId(c);
  if (allDomains.length > 0) {
    await c.env.DB.batch(
      allDomains.map((name) =>
        c.env.DB.prepare("INSERT OR IGNORE INTO user_domains (user_id, domain_name) VALUES (?, ?)")
          .bind(userId, name.toLowerCase())
      )
    );
  }

  return c.json({ ok: true, domains: allDomains });
});

/** 声明一个域名 */
userDomains.post("/", async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "").trim().toLowerCase();
  if (!name || !DOMAIN_RE.test(name)) {
    return c.json({ error: "invalid domain" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT user_id FROM user_domains WHERE domain_name = ?")
    .bind(name).first<{ user_id: string }>();
  if (existing?.user_id === userId) return c.json({ ok: true, name });

  const conflict = await checkClaimable(c, userId, name);
  if (conflict) return c.json({ error: conflict.error }, conflict.status);

  await c.env.DB.prepare(
    "INSERT INTO user_domains (user_id, domain_name) VALUES (?, ?)"
  ).bind(userId, name).run();
  return c.json({ ok: true, name }, 201);
});

/** 取消声明 */
userDomains.delete("/:name", async (c) => {
  const userId = getUserId(c);
  const name = decodeURIComponent(c.req.param("name") ?? "").trim().toLowerCase();
  if (!name) return c.json({ error: "name required" }, 400);

  // 拒绝带账号的域名删除（让用户先清理）
  const inUse = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE user_id = ? AND provider = 'domain' AND email LIKE ?"
  ).bind(userId, `%@${name}`).first<{ n: number }>();
  if ((inUse?.n ?? 0) > 0) {
    return c.json({ error: `${inUse?.n} mailbox(es) still use this domain — delete them first` }, 409);
  }

  await c.env.DB.prepare("DELETE FROM user_domains WHERE user_id = ? AND domain_name = ?")
    .bind(userId, name).run();
  return c.json({ ok: true });
});

export default userDomains;
```

注意：具体路径（`/guide`、`/check-mx`、`/import`、`/sync`）必须注册在 `DELETE /:name` 之前（不同 method 本无冲突，但保持上面顺序即可）。

- [ ] **Step 2: 清理 settings.ts**

在 `src/routes/settings.ts` 中：
1. 删除 `settings.get("/domains/guide", ...)`（32-34 行）。
2. 删除 `settings.post("/domains/check-mx", ...)`（36-60 行）。
3. 删除 `settings.post("/domains/auto-enable", ...)`（62-168 行，含注释块；该端点前端未使用，功能已并入 import）。
4. 删除 `settings.post("/domains/import", ...)`（170-351 行，含注释块）。
5. 删除 `settings.post("/domains/sync", ...)`（434-492 行，含注释块）。
6. `SYSTEM_KEYS` 数组移除 `"EMAIL_DOMAINS"`。
7. 顶部 import 清理：`checkDomainMx`、`getMxGuide`、`normalizeDomain`（../dns）、`autoEnableEmailRouting`、`getCloudflareCredentials`（../cloudflare）、`requireAdmin` 均不再被本文件使用，删除对应 import（保留 `requireJwt`、`getUserId` 等仍在用的）。

- [ ] **Step 3: 类型检查 + 残留检查**

```bash
cd /opt/any-mail && bunx tsc --noEmit
grep -rn "EMAIL_DOMAINS" src/
```

Expected: tsc 无错误；grep 零输出。

- [ ] **Step 4: Commit**

```bash
git add src/routes/user-domains.ts src/routes/settings.ts
git commit -m "feat(api): 域名导入/检测/同步端点迁至 /api/user-domains，写入当前用户"
```

---

### Task 4: 前端 API client 切换端点

**Files:**
- Modify: `web/src/lib/api.ts`

**Interfaces:**
- Consumes: Task 3 的新端点。
- Produces（Task 5/6 依赖，签名不变）: `getDomains(): Promise<{domains: {name: string}[]}>`、`getDomainMxGuide(): Promise<MxGuide>`、`checkDomainMx(domain: string): Promise<MxCheckResult>`、`importDomain(domain, opts?): Promise<DomainImportResult>`、`syncDomainsFromCloudflare(): Promise<{ok: boolean; domains: string[]}>`。`autoEnableDomain` / `AutoEnableResult` 不复存在。

- [ ] **Step 1: 改 URL 与删除废弃函数**

在 `web/src/lib/api.ts` 中：
1. `getDomains`（267 行）：URL `"/api/settings/domains"` → `"/api/domains"`。
2. `syncDomainsFromCloudflare`（271 行）：URL `"/api/settings/domains/sync"` → `"/api/user-domains/sync"`。
3. `getDomainMxGuide`（299 行）：URL → `"/api/user-domains/guide"`。
4. `checkDomainMx`（303 行）：URL → `"/api/user-domains/check-mx"`。
5. `importDomain`（354 行）：URL → `"/api/user-domains/import"`。
6. 删除 `autoEnableDomain` 函数（370-386 行）与 `AutoEnableResult` 接口（318-334 行）。`AutoEnableStep` 保留（`DomainImportResult.steps` 在用）。

- [ ] **Step 2: 类型检查**

Run: `cd /opt/any-mail/web && bunx tsc -b`
Expected: 无错误（此时 Settings.tsx 仍引用保留的函数，均存在）。

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(web): 域名 API client 切换至 /api/domains 与 /api/user-domains"
```

---

### Task 5: Settings.tsx 移除域名卡片

**Files:**
- Modify: `web/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: Task 4 的 api.ts（本任务只删代码，不新增调用）。
- Produces: 设置页仅剩通用 / Cloudflare / Gmail 三个 SettingsSection + 保存按钮。

- [ ] **Step 1: 删除域名相关代码**

在 `web/src/pages/Settings.tsx` 中删除：
1. JSX：`{/* Domain Import + MX Guide */}` 整张 Card（266-446 行）和 `{/* Domain Management */}` 整张 Card（448-511 行）。**删除前先把这两段完整 JSX 复制留存（git stash 不需要，直接从 git HEAD 读即可）——Task 6 要原样迁入 Domains.tsx。**
2. state：`syncingDomains`、`enabledDomains`、`allDomains`、`newDomain`、`importDomainInput`、`mxGuide`、`mxResult`、`checkingMx`、`importingDomain`、`autoSteps`、`pendingNs`、`showGuide`（51-67 行）。
3. handler：`handleSyncDomains`、`handleAddDomain`、`handleCheckMx`、`handleImportDomain`、`toggleDomain`、`removeDomain`、`copyText`（90-206 行）。
4. `useEffect`（69-84 行）：去掉 `getDomainMxGuide()` 与 EMAIL_DOMAINS 解析，简化为：

```ts
  useEffect(() => {
    getSettings()
      .then((res) => {
        const ex: Record<string, { masked: string; updated_at: string }> = {};
        for (const [k, v] of Object.entries(res.settings)) {
          ex[k] = { masked: v.masked, updated_at: v.updated_at };
        }
        setExisting(ex);
      })
      .finally(() => setLoading(false));
  }, []);
```

5. `handleSave`：删除 `changed.EMAIL_DOMAINS = enabledDomains.join(",");` 一行及其上方注释。
6. import 清理：从 `@/lib/api` 只保留 `getSettings, updateSettings`；类型 `MxCheckResult, MxGuide, AutoEnableStep` 删除。`Card/CardContent/...`、`Separator`、`Input`、`Button`、`toast` 仍被剩余代码使用，保留。

- [ ] **Step 2: 类型检查（同时验证无未使用变量报错）**

Run: `cd /opt/any-mail/web && bunx tsc -b`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Settings.tsx
git commit -m "feat(web): 设置页移除域名导入与邮箱域名卡片"
```

---

### Task 6: Domains.tsx 迁入导入向导与 CF 同步

**Files:**
- Modify: `web/src/pages/Domains.tsx`

**Interfaces:**
- Consumes: Task 4 的 `getDomainMxGuide` / `checkDomainMx` / `importDomain` / `syncDomainsFromCloudflare` 及类型 `MxCheckResult` / `MxGuide` / `AutoEnableStep`；页面已有的 `me`（`MeResponse`，含 `user.role`）与 `refresh()`。
- Produces: 我的域名页 = 共享收件卡片 + 导入向导卡片（原设置页「导入域名」，含 MX 指引/检测/pending NS/steps 展示）+ 手动声明卡片 + 域名列表卡片（admin 额外有「从 Cloudflare 同步」按钮）。

- [ ] **Step 1: 迁入 state、handler、辅助函数**

在 `web/src/pages/Domains.tsx`：

1. 扩展 import：

```ts
import {
  getUserDomains, addUserDomain, deleteUserDomain, apiMe,
  getDomainMxGuide, checkDomainMx, importDomain, syncDomainsFromCloudflare,
  type UserDomain, type MeResponse, type MxCheckResult, type MxGuide, type AutoEnableStep,
} from "@/lib/api";
```

2. 组件内新增 state（放在现有 state 之后）：

```ts
  const [importDomainInput, setImportDomainInput] = useState("");
  const [mxGuide, setMxGuide] = useState<MxGuide | null>(null);
  const [mxResult, setMxResult] = useState<MxCheckResult | null>(null);
  const [checkingMx, setCheckingMx] = useState(false);
  const [importingDomain, setImportingDomain] = useState(false);
  const [autoSteps, setAutoSteps] = useState<AutoEnableStep[] | null>(null);
  const [pendingNs, setPendingNs] = useState<{
    domain: string;
    nameservers: string[];
    zone_status?: string;
    zone_created?: boolean;
  } | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [syncingDomains, setSyncingDomains] = useState(false);
```

3. `useEffect` 里追加加载指引（保持现有 refresh() 调用不动）：

```ts
  useEffect(() => {
    refresh();
    getDomainMxGuide().then(setMxGuide).catch(() => {});
  }, []);
```

4. 新增 handler（在 `copy` 函数之后）。与原 Settings.tsx 版本的差异：导入/同步成功后调 `await refresh()` 刷新本页列表，不再维护 `allDomains`/`enabledDomains`；toast 文案 key 沿用 `settings.*`：

```ts
  const handleCheckMx = async () => {
    const d = importDomainInput.trim().toLowerCase();
    if (!d) return;
    setCheckingMx(true);
    setMxResult(null);
    try {
      const res = await checkDomainMx(d);
      setMxResult(res);
      if (res.ok) toast.success(t("settings.mxCheckOk"));
      else toast.error(t(`settings.mxStatus.${res.message}`, { defaultValue: t("settings.mxCheckFail") }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.mxCheckFail"));
    } finally {
      setCheckingMx(false);
    }
  };

  const handleImportDomain = async (force = false) => {
    const d = (pendingNs?.domain || importDomainInput).trim().toLowerCase();
    if (!d) return;
    setImportingDomain(true);
    setAutoSteps(null);
    try {
      const res = await importDomain(d, { force, auto_enable: true, create_zone: true });
      if (res.steps) setAutoSteps(res.steps);
      if (res.mx) setMxResult(res.mx);
      if (!res.ok) {
        if (res.error === "pending_ns" || res.pending_ns) {
          setPendingNs({
            domain: res.domain,
            nameservers: res.nameservers ?? [],
            zone_status: res.zone_status,
            zone_created: res.zone_created,
          });
          setImportDomainInput(res.domain);
          toast.message(
            res.zone_created
              ? t("settings.zoneCreatedPendingNs", { domain: res.domain })
              : t("settings.pendingNs", { domain: res.domain })
          );
          return;
        }
        setPendingNs(null);
        toast.error(
          t(`settings.autoEnableErrors.${res.error}`, {
            defaultValue: res.error || t("settings.domainImportFailed"),
          })
        );
        return;
      }
      setPendingNs(null);
      setImportDomainInput("");
      if (res.auto_enabled) {
        toast.success(t("settings.autoEnableOk", { domain: res.domain, worker: res.worker ?? "any-mail" }));
      } else if (res.forced) {
        toast.success(t("settings.domainImportedForced", { domain: res.domain }));
      } else {
        toast.success(t("settings.domainImported", { domain: res.domain }));
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.domainImportFailed");
      if (msg === "mx_not_ready") toast.error(t("settings.mxNotReady"));
      else toast.error(t(`settings.autoEnableErrors.${msg}`, { defaultValue: msg }));
    } finally {
      setImportingDomain(false);
    }
  };

  const handleSyncDomains = async () => {
    setSyncingDomains(true);
    try {
      const res = await syncDomainsFromCloudflare();
      toast.success(t("settings.domainsSynced", { count: res.domains.length }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.domainsSyncFailed"));
    } finally {
      setSyncingDomains(false);
    }
  };
```

（`copyText` 不需要迁入 —— Domains.tsx 已有等价的 `copy(text, msg?)`，迁入的 JSX 中把 `copyText(...)` 改为 `copy(...)`。）

- [ ] **Step 2: 迁入导入向导 JSX**

从 git HEAD 的 Settings.tsx 读取 `{/* Domain Import + MX Guide */}` 整张 Card（原 266-446 行，`git show HEAD~1:web/src/pages/Settings.tsx` 或 Task 5 提交前的留存），原样插入 Domains.tsx 的共享收件 Card（`</Card>`，约 117 行）之后、手动声明 Card 之前，仅做两处修改：
1. 所有 `copyText(` → `copy(`。
2. 其余保持不变（i18n key、结构、样式全部沿用）。

不迁入 `{/* Domain Management */}` 卡片（chips 全局列表已废弃，本页已有列表卡片）。

- [ ] **Step 3: 域名列表卡片加 admin 同步按钮**

把列表 Card 的 CardHeader（151-157 行）改为：

```tsx
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t("domains.listTitle")}</CardTitle>
              <CardDescription>
                {t("domains.listCount", { count: domains.length })}
              </CardDescription>
            </div>
            {me?.user.role === "admin" && (
              <Button variant="outline" size="sm" disabled={syncingDomains} onClick={handleSyncDomains}>
                {syncingDomains ? t("settings.domainsSyncing") : t("settings.domainsSyncBtn")}
              </Button>
            )}
          </div>
        </CardHeader>
```

- [ ] **Step 4: 类型检查 + lint**

```bash
cd /opt/any-mail/web && bunx tsc -b && bun run lint
```

Expected: 均无错误（lint 若报既有基线问题，仅确认无本次新增的报错）。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Domains.tsx
git commit -m "feat(web): 我的域名页迁入导入向导与 CF 同步"
```

---

### Task 7: 端到端本地验证

**Files:** 无新改动（验证任务；发现问题就地修复后重跑）。

- [ ] **Step 1: 起本地服务**

```bash
cd /opt/any-mail && bun run dev
```

后台运行（wrangler dev :8787，本地 D1 已含 0013 迁移）。

- [ ] **Step 2: API 冒烟**

```bash
# 登录拿 JWT（本地 admin 密码默认 admin；用户名见本地 users 表，bootstrap 为 admin@local）
TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@local","password":"admin"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
# 1) 可用域名 = 本人 user_domains
curl -s http://localhost:8787/api/domains -H "Authorization: Bearer $TOKEN"
# 2) 旧端点已消失
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/api/settings/domains -H "Authorization: Bearer $TOKEN"
# 3) 新 guide 端点
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/api/user-domains/guide -H "Authorization: Bearer $TOKEN"
# 4) MX 导入路径（无 CF 凭据时走 MX 检测，未配置 MX 的域名应 400 mx_not_ready；force 后 200）
curl -s -X POST http://localhost:8787/api/user-domains/import -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"domain":"e2e-check.test","force":true,"auto_enable":false}'
# 5) 用刚导入的域名建账号应成功；用未声明域名建账号应 403
curl -s -X POST http://localhost:8787/api/accounts/domain -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"email":"probe@e2e-check.test"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/api/accounts/domain -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"email":"probe@not-mine.test"}'
```

Expected 依次：`{"domains":[...]}` 仅含本人域名；`404`；`200`；`{"ok":true,...,"scope":"user"}`（`.test` 无 DNS，若 check-mx 对 `.test` 返回 502 则换一个真实但未配 MX 的域名验证 force 路径）；建账号 200/201；最后 `403`。

注：`POST /api/accounts/domain` 的实际路径以 `src/routes/accounts.ts` 中注册的为准（执行时先 `grep -n "post(" src/routes/accounts.ts` 确认），上面命令相应调整。

- [ ] **Step 3: 清理验证数据 + 停服务**

```bash
bunx wrangler d1 execute any-mail-db --local --command "DELETE FROM accounts WHERE email LIKE '%@e2e-check.test'; DELETE FROM user_domains WHERE domain_name = 'e2e-check.test'"
```

停掉 dev 进程。

- [ ] **Step 4: 全量检查 + 收尾提交（如有修复）**

```bash
cd /opt/any-mail && bunx tsc --noEmit && cd web && bunx tsc -b
grep -rn "EMAIL_DOMAINS" /opt/any-mail/src /opt/any-mail/web/src
```

Expected: tsc 双通过；grep 零输出。有修复则单独 commit。

---

### Task 8: 生产发布（需用户确认后执行）

**Files:** 无代码改动。

- [ ] **Step 1: 向用户确认发布**

发布动作影响生产（happy 部署的 Cloudflare Worker + 远程 D1），执行前必须得到用户明确同意。

- [ ] **Step 2: 先迁移后部署**

```bash
cd /opt/any-mail
bun run db:migrate:remote   # 0013 在旧代码上运行安全：旧代码读不到 EMAIL_DOMAINS 只影响建账号下拉几分钟
bun run deploy
```

- [ ] **Step 3: 生产冒烟**

登录生产 Web：我的域名页可见原 6 个域名（xujfqc.xyz、urging.xujfqc.xyz、xyprohani.xyz、flannels.xyprohani.xyz、send.xyprohani.xyz、zxrwa.com）；设置页无域名卡片；建账号下拉正常出这些域名。
