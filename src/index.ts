import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Account } from "./types";
import { login, registerUser, authMiddleware, requireJwt, requireScope, getUserId, ensureRelayToken, type ApiKeyContext, type UserContext } from "./auth";
import { handleDomainEmail } from "./providers/domain";
import { getOAuthCredentials } from "./settings";
import { cronBatchSize, syncAccountWithState, syncDueAccounts } from "./sync";
import emailsRoute from "./routes/emails";
import accountsRoute from "./routes/accounts";
import oauthRoute from "./routes/oauth";
import settingsRoute from "./routes/settings";
import apiKeysRoute from "./routes/api-keys";
import userDomainsRoute from "./routes/user-domains";

const app = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

app.use("/*", cors());

// 健康检查
app.get("/", (c) => c.json({ name: "any-mail", status: "ok" }));

// 登录 — email + password；保留 password-only 兼容老 admin
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  // 老前端可能只传 password → 视为 admin@local 登录
  const email = (body.email ?? "").trim() || "admin@local";
  const password = body.password ?? "";
  const result = await login(email, password, c.env);
  if ("error" in result) return c.json({ error: result.error }, 401);
  return c.json({ token: result.token, user: result.user });
});

// 注册（开放）
app.post("/api/auth/register", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const result = await registerUser(body.email ?? "", body.password ?? "", c.env);
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json({ token: result.token, user: result.user }, 201);
});

// OAuth 路由（start 子路由内部要登录，callback 不需要）
app.route("/api/oauth", oauthRoute);

// 以下所有 /api/* 路由需要认证
app.use("/api/*", authMiddleware());

// 当前用户信息（含 email + relay_token + 共享域名，用于 UI 展示）
app.get("/api/me", async (c) => {
  const user = c.get("user")!;
  const relay_token = await ensureRelayToken(c.env.DB, user.id);
  const [emailRow, sharedRow] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(user.id),
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'SHARED_INBOX_DOMAIN'"),
  ]);
  const email = (emailRow?.results[0] as { email: string } | undefined)?.email ?? null;
  const shared_inbox_domain = ((sharedRow?.results[0] as { value: string } | undefined)?.value ?? "").trim().toLowerCase() || null;
  return c.json({ user: { ...user, email, relay_token }, shared_inbox_domain });
});

// 路由挂载
app.route("/api/emails", emailsRoute);
app.route("/api/accounts", accountsRoute);
app.route("/api/settings", settingsRoute);
app.route("/api/keys", apiKeysRoute);
app.route("/api/user-domains", userDomainsRoute);

// 当前用户可用域名（JWT 或 API key 均按所属用户返回；API key 需 domains:read）
app.get("/api/domains", requireScope("domains:read"), async (c) => {
  const userId = getUserId(c);
  const rows = await c.env.DB.prepare(
    "SELECT domain_name FROM user_domains WHERE user_id = ? ORDER BY domain_name"
  ).bind(userId).all<{ domain_name: string }>();
  return c.json({ domains: rows.results.map((r) => ({ name: r.domain_name })) });
});

// 手动触发同步（当前用户的所有账号）— 仅限 JWT
app.post("/api/sync", requireJwt(), async (c) => {
  const userId = getUserId(c);
  const result = await syncUserAccounts(c.env, userId);
  return c.json(result);
});

// 同步单个账号（属主校验）
app.post("/api/accounts/:id/sync", requireScope("accounts:write"), async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<Account>();

  if (!account) return c.json({ error: "not found" }, 404);
  const key = c.get("apiKey");
  if (key?.provider && account.provider !== key.provider) {
    return c.json({ error: "not found" }, 404);
  }
  if (account.provider === "domain") return c.json({ error: "domain accounts receive email passively" }, 400);

  const creds = await getOAuthCredentials(c.env, userId);
  const result = await syncAccountWithState(c.env, account, creds);
  if (result.error) {
    return c.json({
      ok: false,
      email: account.email,
      provider: account.provider,
      synced: 0,
      error: result.error,
      needs_reauth: !!result.needsReauth,
    }, 500);
  }
  return c.json({ ok: true, email: account.email, provider: account.provider, synced: result.synced });
});

/**
 * 同步单个用户最久未同步的一批 Gmail/Outlook 账号（跳过需重新授权的账号）。
 * 单次请求受 Workers 子请求/D1 查询上限约束，因此按批处理而不是一次同步全部。
 */
async function syncUserAccounts(env: Env, userId: string) {
  const creds = await getOAuthCredentials(env, userId);
  const now = new Date().toISOString();
  const accounts = await env.DB.prepare(
    `SELECT * FROM accounts
      WHERE user_id = ? AND provider IN ('gmail', 'outlook') AND needs_reauth = 0
        AND (expires_at IS NULL OR expires_at >= ?)
      ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
      LIMIT ?`
  ).bind(userId, now, cronBatchSize(env)).all<Account>();

  const results: { email: string; provider: string; synced: number; error?: string }[] = [];
  for (const account of accounts.results) {
    const result = await syncAccountWithState(env, account, creds);
    results.push({ email: account.email, provider: account.provider, synced: result.synced, ...(result.error ? { error: result.error } : {}) });
  }

  return { ok: true, results };
}

/** 清理已过期账号及其邮件（expires_at < now） */
async function cleanupExpiredAccounts(env: Env): Promise<number> {
  const now = new Date().toISOString();

  // 先删邮件，再删账号（与 DELETE /api/accounts/:id 一致）
  await env.DB.prepare(
    `DELETE FROM emails WHERE account_id IN (
      SELECT id FROM accounts WHERE expires_at IS NOT NULL AND expires_at < ?
    )`
  ).bind(now).run();

  const res = await env.DB.prepare(
    "DELETE FROM accounts WHERE expires_at IS NOT NULL AND expires_at < ?"
  ).bind(now).run();

  return res.meta?.changes ?? 0;
}

export default {
  fetch: app.fetch,

  // Cloudflare Email Worker: 接收域名邮件
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleDomainEmail(message, env);
  },

  // Cron Trigger: 清理过期账号 + 轮询 Gmail / Outlook
  async scheduled(_event: ScheduledEvent, env: Env) {
    await cleanupExpiredAccounts(env);
    await syncDueAccounts(env);
  },
};
