# 收件箱「已发送」切换 tab

日期：2026-07-28
状态：已确认

## 背景与目标

发送邮件（Resend）成功后记录已入库（`emails.provider='resend'`，2026-07-28 修复外键后生效），但 UI 无处查看：Compose 发送后直接跳收件箱，且已发送记录会混入收件箱列表。

**目标**：收件箱页顶部加「收件箱 / 已发送」切换 tab；发送成功后落地到已发送视图；收件视图不再混入已发送邮件。

**不做**：独立已发送页面/路由、后端新表或迁移、API key 行为变更。

## 1. 后端（src/routes/emails.ts `GET /`）

新增查询参数 `box`：

- `box=sent` → SQL 追加 `AND provider = 'resend'`。
- 未传 `box` 且最终 `provider` 为空（既无 query 也无 API key 绑定）→ SQL 追加 `AND provider != 'resend'`（默认收件视图）。
- 显式 `provider`（query 或 API key 绑定）存在时：行为与现在完全一致，`box` 忽略。

count 查询同步加相同条件。兼容性：resend 记录修复前从未成功入库，默认排除不影响任何既有客户端；需要全部数据的客户端可显式传 `provider=resend` 或 `box=sent`。

## 2. 前端

### lib/api.ts
`getEmails` 参数对象增加 `box?: string`，透传为查询参数。

### Inbox.tsx
- 新增 state `box`，初始值取 URL `searchParams.get("box") || "inbox"`；切换 tab 时用 `setSearchParams` 写回 URL（`box=sent` 或删除该参数），并重置页码。
- 请求时 `box === "sent"` → `params.box = "sent"`，并且不传 `provider`。
- tab UI：列表卡片上方两个按钮式 tab（沿用页面现有 shadcn 风格，不引入新组件依赖），文案 i18n：`inbox.tabInbox`（收件箱/Inbox）、`inbox.tabSent`（已发送/Sent）。
- 已发送视图下隐藏 provider 下拉；账号筛选保留（含义为发件账号）。
- `useEffect` 依赖数组加入 `box`。

### Compose.tsx
发送成功后 `navigate("/console?box=sent")`（替换现有 `navigate("/console")`）。

### locales
`zh.json` / `en.json` 增加 `inbox.tabInbox`、`inbox.tabSent`。

## 3. 错误处理

无新错误路径；`box` 非法值按未传处理（后端只识别 `sent`）。

## 4. 验证

- `bunx tsc --noEmit`、`cd web && bunx tsc -b` 通过。
- 本地：`GET /api/emails` 默认不含 resend 行；`?box=sent` 只含 resend 行；`?provider=gmail` 行为不变。
- 手动：发送邮件 → 落地已发送 tab 且能看到该邮件 → 切回收件箱不见它 → URL 带 `box=sent` 刷新后仍在已发送视图。
