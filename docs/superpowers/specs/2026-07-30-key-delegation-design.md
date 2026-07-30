# API Key 委派建 key(keys:create)设计

日期:2026-07-30
状态:已确认

## 背景与目标

当前 `/api/keys` 全部路由挂 `requireJwt()`,只有账号密码登录得到的 JWT 才能创建/管理 API key,API key 被禁止访问 key 管理接口(防自我提权)。

目标:允许持有特定 scope 的 API key 直接创建并管理自己派生的子 key,使外部自动化程序(如注册机)无需账号密码即可完成 key 的供给与回收(「用 key 建 key」),同时保证权限只收窄、不放大。

## 数据与权限模型

### 迁移 `migrations/0014_key_lineage.sql`

```sql
ALTER TABLE api_keys ADD COLUMN created_by_key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_parent ON api_keys(created_by_key_id);
```

- `created_by_key_id = NULL` 表示由用户在 JWT 会话下手动创建(现有行为)。
- 不使用外键,级联删除在应用层用递归 CTE 实现。

### 新 scope

- `keys:create` 加入 `src/routes/api-keys.ts` 的 `VALID_SCOPES` 与 `src/auth.ts` 的 `Scope` 类型。
- **`*` 不隐含 `keys:create`**:必须显式携带该 scope 才能访问 key 管理接口。否则线上已存在的 `*` key 会在部署后静默获得建 key 能力,构成提权。注意这与 `requireScope()` 中 `*` 通配放行的通用逻辑不同——key 管理路由不走 `requireScope()`,使用专用守卫做显式判断。

## 子集限制规则

设父 key P(发起请求的 key)、子 key C(被创建或被编辑的 key)。创建(POST)和编辑(PATCH)时都强制:

1. **scopes**:C 的每个 scope,P 的 scopes 里必须含同名项或 `*`。P 含 `keys:create` 时 C 也可显式带 `keys:create`,即允许链式委派。
2. **provider**:P.provider 非 NULL 时,C.provider 必须与之相等;P.provider 为 NULL 则不限。
3. **address**:P.address 非 NULL 时,C.address 必须非空且包含 P.address 作为子串(address 语义是收件地址子串匹配,子串包含保证匹配范围只收窄);P.address 为 NULL 则不限。
4. **expires_at**:P.expires_at 非 NULL 时,C.expires_at 必须非 NULL 且不晚于 P.expires_at;P 无过期时间则不限。
5. C 的 `user_id` 继承 P 的 `user_id`;`created_by_key_id` 写入 P 的 id。

校验失败返回 400,错误信息说明哪条规则不满足。

## 路由改造(`src/routes/api-keys.ts`)

去掉整组 `keys.use("*", requireJwt())`,改为双模守卫中间件:

- **JWT 模式**:行为与现状完全一致(全量列出/创建/编辑/轮换/删除本用户所有 key,无子集限制)。
- **API key 模式**:key 的 scopes 必须显式含 `keys:create`,否则 403;通过后视野收窄:

| 路由 | key 模式行为 |
|---|---|
| `GET /` | 只返回 `created_by_key_id = 本 key id` 的直接子 key |
| `POST /` | 创建子 key,强制子集规则,写入血缘字段 |
| `PATCH /:id` | 目标必须是直接子 key,否则 404;修改 scopes/provider/address/expires_at 时重跑子集校验 |
| `POST /:id/rotate` | 目标必须是直接子 key,否则 404 |
| `DELETE /:id` | 目标必须是直接子 key,否则 404;递归级联删除全部后代 |

- key 永远无法读取/修改/轮换/删除**自己**(自己不是自己的子 key,天然被直接子 key 校验挡住,无需特判)。
- **级联删除对 JWT 模式同样生效**:任何 DELETE 都用递归 CTE(`WITH RECURSIVE`)收集目标 key 的全部后代一并删除,不留孤儿 key。

### GET / 响应扩展

返回字段增加 `created_by_key_id`,并 LEFT JOIN 父 key 带出 `created_by_prefix`(父 key 的 `key_prefix`,父已被删则为 NULL),供前端显示来源。

## 前端(`web/src/pages/ApiKeys.tsx`)

1. 创建/编辑表单的 scope 勾选列表加入 `keys:create`,附说明文案「允许该 key 创建并管理子 key」。
2. key 列表中 `created_by_key_id` 非空的行显示来源徽章:「由 `<created_by_prefix>…` 创建」(父 key 已删除时显示「由已删除的 key 创建」)。不做树形展开。

## 文档

更新 `docs/API.md`:

- `keys:create` scope 说明与 `*` 不隐含它的规则。
- key 模式下五个 key 管理端点的行为、子集规则全文、级联删除语义。

## 错误处理

- key 无 `keys:create` scope 访问 `/api/keys/*` → 403(沿用现有错误 JSON 风格)。
- 子集规则违反 → 400,message 指明具体哪条规则(scope 越界 / provider 不符 / address 未收窄 / expires_at 越界)。
- key 模式操作非自己子 key 的 id → 404(与「不存在」不可区分,避免枚举探测)。

## 验证方式

项目无测试框架,按现有惯例:

1. 后端 `bunx tsc --noEmit`;前端 `cd web && bunx tsc -b && bun run lint`。
2. 本地 `bun run dev` 起 Worker,用 curl 走通完整链路:
   - JWT 登录 → 建带 `keys:create` + 若干 scope 的父 key;
   - 用父 key 建子 key(合法子集)→ 成功,`created_by_key_id` 正确;
   - 越权用例逐条确认被拒:无 `keys:create` 的 key 访问管理接口(403)、仅 `*` 无 `keys:create`(403)、子 scope 超出父(400)、provider/address/expires_at 放大(400)、操作非子 key id(404)、操作自己(404);
   - 删除父 key → 子 key、孙 key 全部消失,且旧子 key 立即无法认证。

## 不做的事(YAGNI)

- 不做 key 使用配额/速率限制。
- 不做子 key 数量上限。
- 不做前端树形层级展示。
- 不改 `/api/settings`、`POST /api/sync` 的 JWT-only 限制。
