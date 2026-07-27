# 域名管理全面按用户化（移除全局 EMAIL_DOMAINS）

日期：2026-07-27
状态：已确认

## 背景与目标

当前域名可用性是双轨制：

- **全局列表**：`settings.EMAIL_DOMAINS`（逗号分隔），admin 在设置页「邮箱域名」卡片管理，所有用户共享可用。
- **个人声明**：`user_domains` 表，「我的域名」页管理，仅本人可用。

建账号校验、可用域名列表、导入向导等处都要做「全局 + 个人」合并与互斥特判，逻辑分散且易错。

**目标**：移除全局列表，`user_domains` 成为域名归属的唯一来源；域名管理 UI 全部收敛到「我的域名」页，每个用户（含 admin）只管理自己的域名。

**不做**：`SHARED_INBOX_DOMAIN`（公共收码域名）保持现状；收信 worker 的 catch-all 逻辑不动（收信按收件地址匹配账号，不查域名表）；API key `domains:read` scope 语义不变。

前提事实：当前实例实际只有 admin 一个活跃用户，全局域名下的账号均属 admin，无需处理其他用户的存量账号。

## 1. 数据迁移（migrations/0013_migrate_global_domains.sql）

- 用 SQLite 递归 CTE 拆分 `settings.EMAIL_DOMAINS` 的逗号列表，`INSERT OR IGNORE INTO user_domains (user_id, domain_name)`，`user_id` 取 `(SELECT id FROM users WHERE role='admin' LIMIT 1)`（bootstrap 值为 `'admin'`）。
- 拆分时 trim 空白、转小写、过滤空串；已被其他用户占用的域名因 `domain_name UNIQUE` 由 OR IGNORE 跳过。
- 最后 `DELETE FROM settings WHERE key = 'EMAIL_DOMAINS'`。
- 幂等：重复执行无副作用（OR IGNORE + DELETE 均幂等）。

## 2. 后端

### 收敛读取方（不再读 EMAIL_DOMAINS）

- `src/index.ts` `GET /api/domains`：改为返回 `getUserId(c)` 用户在 `user_domains` 里的域名（JWT 与 API key 均携带 user_id，`getUserId` 已统一）。响应结构不变：`{ domains: string[] }`。
- `src/routes/accounts.ts` 建域名账号校验：只查 `user_domains WHERE user_id = ? AND domain_name = ?`。
- `src/routes/settings.ts` 内的可用域名接口（avail-domains）：删除，前端统一改用 `/api/domains`。

### 路由迁移（settings.ts → user-domains.ts）

以下端点整体搬到 `/api/user-domains` 命名空间下，settings.ts 中删除：

- `POST /check-mx`（原 `/api/settings/domains/check-mx`）：逻辑不变。
- `GET /guide`（原 `/domains/guide`）：逻辑不变。
- `POST /import`（原 `/domains/import`）：
  - admin 且有 CF 凭据且 `auto_enable`：走 `autoEnableEmailRouting`（建 Zone / Email Routing / catch-all → Worker），成功后写入**admin 自己的 user_domains**（原来写全局）。
  - 其余（admin 无凭据 / 普通用户）：MX 检测通过（或 force）后写入本人 user_domains。
  - 响应中 `scope` 字段统一为 `"user"`，`domains` 返回本人域名列表。
- `POST /sync-from-cloudflare`（原 admin「从 Cloudflare 同步」）：仍 `requireAdmin()`，同步结果写入 admin 自己的 user_domains（INSERT OR IGNORE），不再覆写 settings。

### 清理特判

- `user-domains.ts` 声明域名时「与全局 EMAIL_DOMAINS 重合禁止」的检查删除；「与 SHARED_INBOX_DOMAIN 重合禁止」保留。
- `settings.ts` 的 `SYSTEM_KEYS` 列表移除 `EMAIL_DOMAINS`；`GET /api/settings` 不再返回该项。
- 全仓 grep `EMAIL_DOMAINS`，除迁移文件外应零残留。

## 3. 前端（web/src）

- **Settings.tsx**：删除「导入域名」「邮箱域名」两个卡片及相关 state/调用。
- **Domains.tsx（我的域名）**：
  - 迁入「导入域名」向导卡片（域名输入、检测 MX、导入并启用、接入指引、pending_ns/nameservers 展示），调用新的 `/api/user-domains/*` 端点。
  - 现有个人域名列表保持（增删、删除前须清空该域名下账号的约束不变）。
  - 「从 Cloudflare 同步」按钮迁入，仅 `role === 'admin'` 时渲染。
- **lib/api.ts**：域名相关函数改指向新端点；删除废弃的 settings 域名函数。
- 建账号页（Accounts.tsx）的域名下拉数据源若走旧接口则切到 `/api/domains`（行为不变：返回本人可用域名）。

## 4. 错误处理

- 导入/声明冲突：`409 domain already claimed by another user`（既有行为保留）。
- CF 自动启用失败：透传 `pending_ns`、`nameservers` 等结构（既有行为保留）。
- 迁移后若某用户请求 `/api/domains` 且无任何域名：返回空数组，前端建账号下拉显示空态（已有空态处理）。

## 5. 测试 / 验证

- `bunx tsc --noEmit`（后端）、`cd web && bunx tsc -b`（前端）通过。
- 本地 `bun run db:migrate:local` 后验证：`user_domains` 含原 6 个全局域名且归属 admin；settings 无 EMAIL_DOMAINS 行。
- 手动路径：我的域名页可见迁移后的域名 → 用其中一个建域名账号成功 → 设置页无域名卡片 → admin 点「从 CF 同步」写入个人列表。
- 部署顺序：先 `db:migrate:remote` 再 `deploy`（新代码不读 EMAIL_DOMAINS，旧代码兼容仍读得到——迁移先行则旧代码短暂窗口内读不到全局列表，可接受，实际只影响建账号下拉几秒钟）。
