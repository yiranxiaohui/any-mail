# AnyMail

统一邮件收件箱，聚合多种邮箱来源，部署在 Cloudflare Workers 上。

## 功能特性

- 域名邮箱实时接收（Cloudflare Email Worker）
- Gmail / Outlook 邮箱自动同步（每分钟轮询）
- 管理员登录认证（JWT）
- 收件箱搜索、按账号筛选
- 邮件详情支持 Text / HTML 视图切换
- OAuth 凭据可在网页 Settings 中配置
- GitHub Actions 自动部署

## 支持的邮箱类型

| 类型 | 接收方式 | 延迟 |
|------|---------|------|
| 域名邮箱 | Cloudflare Email Worker 推送 | 实时 |
| Gmail | Gmail API 轮询 | ~1 分钟 |
| Outlook | Microsoft Graph API 轮询 | ~1 分钟 |

## 架构

```
┌──────────────┐  ┌──────────────┐  ┌────────────────┐
│ 域名邮箱 (MX) │  │ Gmail API    │  │ Outlook Graph  │
│ Email Worker  │  │ Cron 轮询     │  │ Cron 轮询       │
└──────┬───────┘  └──────┬───────┘  └───────┬────────┘
       │                 │                   │
       ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────┐
│          Cloudflare Worker (Hono API)                │
│                                                     │
│  POST /api/auth/login     登录获取 token              │
│  GET  /api/emails         查询邮件列表                │
│  GET  /api/emails/:id     查询邮件详情                │
│  GET  /api/accounts       查看已绑定账号              │
│  GET  /api/oauth/gmail    Gmail 授权                 │
│  GET  /api/oauth/outlook  Outlook 授权               │
│  GET  /api/settings       获取系统设置                │
│  PUT  /api/settings       更新系统设置                │
│  POST /api/sync           手动触发同步                │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Cloudflare D1  │
              │  (SQLite)       │
              └─────────────────┘
```

前端使用 React + Vite + shadcn/ui，通过 API 与后端交互。

## 快速开始

### 前置要求

- [Bun](https://bun.sh/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`bun add -g wrangler`)
- Cloudflare 账号

### 1. 安装依赖

```bash
bun install
cd web && bun install
```

### 2. 创建 D1 数据库

```bash
wrangler d1 create any-mail-db
```

将返回的 `database_id` 填入 `wrangler.toml`。

### 3. 配置环境变量

创建 `.dev.vars` 文件用于本地开发：

```
ADMIN_PASSWORD=your-admin-password
JWT_SECRET=a-random-secret-string
```

> Gmail / Outlook 的 OAuth 凭据可以在部署后通过网页 **Settings** 页面配置，无需写在环境变量中。

### 4. 初始化数据库

```bash
bun run db:migrate:local
```

### 5. 启动开发

```bash
# 终端 1：后端
bun run dev

# 终端 2：前端
cd web && bun run dev
```

打开 `http://localhost:5173`，使用 `ADMIN_PASSWORD` 中设置的密码登录。

## 部署

### 方式一：GitHub Actions 自动部署（推荐）

Push 到 `main` 分支自动触发部署。在 GitHub 仓库 Settings → Secrets 中配置：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（使用 "Edit Cloudflare Workers" 模板创建） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右侧栏的 Account ID |
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `JWT_SECRET` | JWT 签名密钥（随机字符串） |

部署完成后，登录前端 → **Settings** 页面配置 Gmail / Outlook 的 OAuth 凭据。

### 方式二：手动部署

```bash
# 配置 Secrets
wrangler secret put ADMIN_PASSWORD
wrangler secret put JWT_SECRET

# 执行数据库迁移
bun run db:migrate:remote

# 部署 Worker
bun run deploy
```

### 配置域名邮箱（可选）

1. Cloudflare Dashboard → 你的域名 → Email → Email Routing
2. 启用 Email Routing，Cloudflare 会自动添加 MX 记录
3. 添加路由规则，将 `*@yourdomain.com` 路由到 `any-mail` Worker

## Gmail 配置

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建项目，启用 Gmail API
3. 创建 OAuth 2.0 凭据，类型选"Web 应用"
4. 授权重定向 URI 添加 `https://your-worker.workers.dev/api/oauth/gmail/callback`
5. 在 AnyMail **Settings** 页面填入 Client ID 和 Client Secret

## Outlook 配置

1. 前往 [Azure Portal](https://portal.azure.com/) → App registrations
2. 注册新应用，支持的账户类型选"任何组织目录中的账户和个人 Microsoft 账户"
3. 添加重定向 URI：`https://your-worker.workers.dev/api/oauth/outlook/callback`（类型选 Web）
4. 创建客户端密码
5. API 权限添加 `Mail.Read`（委托权限）
6. 在 AnyMail **Settings** 页面填入 Client ID 和 Client Secret

## 技术栈

**后端：** Cloudflare Workers · Hono · D1 (SQLite) · postal-mime

**前端：** React 19 · Vite · Tailwind CSS · shadcn/ui · React Router

## License

[MIT](LICENSE)
