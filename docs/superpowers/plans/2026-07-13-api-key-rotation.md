# API Key 轮换（Rotation）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 API key 提供轮换能力——生成新密文并立即替换旧密文，保留 key 的全部配置（id、name、scopes、provider、address、expires_at）。

**Architecture:** 后端在 `src/routes/api-keys.ts` 新增 `POST /:id/rotate` 端点（JWT-only，复用 `generateApiKey()`，直接 UPDATE `key_hash`/`key_prefix`，无数据库迁移）。前端在 ApiKeys 页面每行加「轮换」按钮，成功后复用现有的明文一次性展示 Dialog。

**Tech Stack:** Hono + Cloudflare Workers + D1（后端）；React 19 + Vite + shadcn/ui（base-ui 变体）+ i18next（前端）。

**Spec:** `docs/superpowers/specs/2026-07-13-api-key-rotation-design.md`

## Global Constraints

- 明文密钥仅在轮换响应中返回一次，DB 只存 SHA-256（沿用现有 `generateApiKey()` 约定）。
- 旧密钥在轮换成功瞬间失效，无宽限期。
- key 管理路由全部 JWT-only（文件顶部已有 `keys.use("*", requireJwt())`，新端点自动生效）；API key 调用返回 403。
- shadcn/ui 是 base-ui 变体：Button 无 `asChild`。
- 本仓库无单元测试基础设施（无 vitest/test 文件）——验证方式为 `tsc` 类型检查 + 对本地 dev server 的 curl 端到端验证（与 spec 的验证标准一致）。
- 后端类型检查：根目录 `bunx tsc --noEmit`；前端：`cd web && bunx tsc -b`。

---

### Task 1: 后端轮换端点

**Files:**
- Modify: `src/routes/api-keys.ts`（在 PATCH 处理器之后、DELETE 之前插入，约 130 行处）

**Interfaces:**
- Consumes: `generateApiKey(): Promise<{ plaintext, hash, prefix }>`、`getUserId(c)`（均已从 `../auth` 导入，无需新增 import）。
- Produces: `POST /api/keys/:id/rotate` → `201` 无；成功 `200`：`{ ok: true, key: { id, name, key_prefix, scopes: string[], provider, address, expires_at }, plaintext: string }`（与创建接口响应结构一致）；`404 { error: "key not found" }`；API key 调用 `403`。Task 2 的 `rotateApiKey()` 依赖此响应结构。

- [ ] **Step 1: 写实现**

在 `src/routes/api-keys.ts` 的 PATCH 处理器（`keys.patch("/:id", ...)`）结束之后、DELETE 处理器之前插入：

```ts
/** 轮换 API key：生成新密文并立即替换，旧密钥即刻失效；新明文仅本次响应返回 */
keys.post("/:id/rotate", async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");

  const row = await c.env.DB.prepare(
    "SELECT id, name, scopes, provider, address, expires_at FROM api_keys WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{
    id: string;
    name: string;
    scopes: string;
    provider: string | null;
    address: string | null;
    expires_at: string | null;
  }>();
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
```

- [ ] **Step 2: 类型检查**

Run（仓库根目录）: `bunx tsc --noEmit`
Expected: 无输出（退出码 0）。

- [ ] **Step 3: 启动本地 dev server**

另开一个终端（或后台运行）：

```bash
bun run dev
```

Expected: wrangler dev 监听 `http://localhost:8787`。若本地 D1 尚未建表，先执行 `bun run db:migrate:local`。

- [ ] **Step 4: curl 端到端验证**

```bash
# 登录拿 JWT（本地默认密码 admin；若改过请替换）
TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"admin"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 创建测试 key，记下旧明文与 id
CREATE=$(curl -s -X POST http://localhost:8787/api/keys \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"rotate-test","scopes":["emails:read"]}')
OLD_KEY=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["plaintext"])')
KEY_ID=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"]["id"])')

# 1) 旧密钥当前可用
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:8787/api/emails/latest -H "Authorization: Bearer $OLD_KEY"
# 期望：200

# 2) 轮换
ROTATE=$(curl -s -X POST "http://localhost:8787/api/keys/$KEY_ID/rotate" \
  -H "Authorization: Bearer $TOKEN")
echo "$ROTATE"
# 期望：{"ok":true,"key":{...同创建时的配置，key_prefix 已变化...},"plaintext":"ak_..."}
NEW_KEY=$(echo "$ROTATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["plaintext"])')

# 3) 旧密钥立即失效，新密钥可用
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:8787/api/emails/latest -H "Authorization: Bearer $OLD_KEY"
# 期望：401
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:8787/api/emails/latest -H "Authorization: Bearer $NEW_KEY"
# 期望：200

# 4) 不存在的 id
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:8787/api/keys/does-not-exist/rotate -H "Authorization: Bearer $TOKEN"
# 期望：404

# 5) 用 API key 调轮换端点（requireJwt 拒绝）
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "http://localhost:8787/api/keys/$KEY_ID/rotate" -H "Authorization: Bearer $NEW_KEY"
# 期望：403

# 清理测试 key
curl -s -X DELETE "http://localhost:8787/api/keys/$KEY_ID" -H "Authorization: Bearer $TOKEN"
# 期望：{"ok":true}
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat: add API key rotation endpoint (POST /api/keys/:id/rotate)"
```

---

### Task 2: 前端轮换按钮 + 明文展示

**Files:**
- Modify: `web/src/lib/api.ts`（`deleteApiKey` 之后，约 308 行处）
- Modify: `web/src/pages/ApiKeys.tsx`（import、`handleRevoke` 附近、操作按钮区约 323-339 行）
- Modify: `web/src/locales/en.json`、`web/src/locales/zh.json`（`apiKeys` 段）

**Interfaces:**
- Consumes: Task 1 的 `POST /api/keys/:id/rotate` 响应 `{ ok, key, plaintext }`；页面已有的 `plaintext` state（`{ key: string; name: string }`，驱动一次性展示 Dialog）、`fetchKeys()`、`toast`、`t()`。
- Produces: `rotateApiKey(id: string)`（返回类型与 `createApiKey` 相同）；每行 key 的「轮换」按钮。

- [ ] **Step 1: 在 `web/src/lib/api.ts` 添加客户端函数**

在 `deleteApiKey` 之后添加：

```ts
export function rotateApiKey(id: string) {
  return request<{ ok: boolean; key: Omit<ApiKey, "last_used_at" | "created_at">; plaintext: string }>(
    `/api/keys/${id}/rotate`,
    { method: "POST" }
  );
}
```

- [ ] **Step 2: 在 `web/src/pages/ApiKeys.tsx` 添加 handler 和按钮**

（a）扩展 import（第 9 行）：

```ts
import { getApiKeys, createApiKey, updateApiKey, deleteApiKey, rotateApiKey, type ApiKey } from "@/lib/api";
```

（b）在 `handleRevoke` 之后添加：

```tsx
const handleRotate = async (key: ApiKey) => {
  if (!confirm(t("apiKeys.rotateConfirm", { name: key.name }))) return;
  try {
    const res = await rotateApiKey(key.id);
    setPlaintext({ key: res.plaintext, name: key.name });
    toast.success(t("apiKeys.rotated", { name: key.name }));
    fetchKeys();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("apiKeys.rotateFailed"));
  }
};
```

（c）在操作按钮区（`flex gap-1 shrink-0` 容器内），在「编辑」按钮和「撤销」按钮之间插入：

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={() => handleRotate(key)}
>
  {t("apiKeys.rotate")}
</Button>
```

- [ ] **Step 3: 补充 i18n 文案**

`web/src/locales/en.json` 的 `apiKeys` 段（`revoke` 键之前）加入：

```json
"rotate": "Rotate",
"rotateConfirm": "Rotate key {{name}}? The current key will stop working immediately.",
"rotated": "Rotated {{name}} — copy the new key now",
"rotateFailed": "Failed to rotate key",
```

`web/src/locales/zh.json` 的 `apiKeys` 段同位置加入：

```json
"rotate": "轮换",
"rotateConfirm": "确定轮换密钥 {{name}}？当前密钥将立即失效。",
"rotated": "已轮换 {{name}}，请立即复制新密钥",
"rotateFailed": "轮换密钥失败",
```

- [ ] **Step 4: 前端类型检查 + 构建**

Run: `cd web && bunx tsc -b && bun run build`
Expected: 类型检查通过，vite build 成功。

- [ ] **Step 5: UI 手动验证**

前提：后端 dev server（:8787）仍在运行。

```bash
cd web && bun run dev
```

浏览器打开 `http://localhost:5173/api-keys`，登录后：
1. 创建一个 key（若列表为空）。
2. 点击该行「轮换」→ 出现确认框，文案提示旧密钥立即失效。
3. 确认后弹出明文 Dialog，展示 `ak_` 开头的新密钥；关闭后列表中该 key 的前缀已更新，id/name/scopes 不变。
4. 切换语言验证中英文案均正常显示。

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/pages/ApiKeys.tsx web/src/locales/en.json web/src/locales/zh.json
git commit -m "feat: add rotate button for API keys in web UI"
```
