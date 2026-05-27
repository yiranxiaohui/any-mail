import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Account } from "./types";
import { login, registerUser, authMiddleware, requireJwt, requireScope, getUserId, ensureRelayToken, type ApiKeyContext, type UserContext } from "./auth";
import { handleDomainEmail } from "./providers/domain";
import { syncGmailEmails } from "./providers/gmail";
import { syncOutlookEmails } from "./providers/outlook";
import { getOAuthCredentials } from "./settings";
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

// 公开域名列表（系统级，所有登录用户可见，API key 可通过 domains:read 访问）
app.get("/api/domains", requireScope("domains:read"), async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
    .first<{ value: string }>();
  const domains = row?.value
    ? row.value.split(",").map((d) => d.trim()).filter(Boolean).map((name) => ({ name }))
    : [];
  return c.json({ domains });
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
  try {
    let synced = 0;
    if (account.provider === "gmail") {
      synced = await syncGmailEmails(account, creds, c.env.DB);
    } else if (account.provider === "outlook") {
      synced = await syncOutlookEmails(account, creds, c.env.DB);
    }
    return c.json({ ok: true, email: account.email, provider: account.provider, synced });
  } catch (err) {
    return c.json({ ok: false, email: account.email, provider: account.provider, synced: 0, error: err instanceof Error ? err.message : "unknown error" }, 500);
  }
});

/** 同步单个用户的所有 Gmail/Outlook 账号 */
async function syncUserAccounts(env: Env, userId: string) {
  const creds = await getOAuthCredentials(env, userId);
  const accounts = await env.DB.prepare(
    "SELECT * FROM accounts WHERE user_id = ? AND provider IN ('gmail', 'outlook')"
  ).bind(userId).all<Account>();

  const results: { email: string; provider: string; synced: number; error?: string }[] = [];

  for (const account of accounts.results) {
    try {
      let synced = 0;
      if (account.provider === "gmail") {
        synced = await syncGmailEmails(account, creds, env.DB);
      } else if (account.provider === "outlook") {
        synced = await syncOutlookEmails(account, creds, env.DB);
      }
      results.push({ email: account.email, provider: account.provider, synced });
    } catch (err) {
      results.push({
        email: account.email,
        provider: account.provider,
        synced: 0,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return { ok: true, results };
}

/** 定时任务：遍历所有用户，逐个同步他们的账号 */
async function syncAllUsers(env: Env) {
  // 一次性 join 出 (account, user_id)；按 user 分组迭代以每个用户用各自的 OAuth 凭证
  const accounts = await env.DB.prepare(
    "SELECT * FROM accounts WHERE provider IN ('gmail', 'outlook') ORDER BY user_id"
  ).all<Account>();

  const byUser = new Map<string, Account[]>();
  for (const a of accounts.results) {
    if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
    byUser.get(a.user_id)!.push(a);
  }

  for (const [userId, userAccounts] of byUser) {
    const creds = await getOAuthCredentials(env, userId);
    for (const account of userAccounts) {
      try {
        if (account.provider === "gmail") {
          await syncGmailEmails(account, creds, env.DB);
        } else if (account.provider === "outlook") {
          await syncOutlookEmails(account, creds, env.DB);
        }
      } catch {
        // 单个账号同步失败不影响其他
      }
    }
  }
}

export default {
  fetch: app.fetch,

  // Cloudflare Email Worker: 接收域名邮件
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleDomainEmail(message, env);
  },

  // Cron Trigger: 定时轮询 Gmail / Outlook
  async scheduled(_event: ScheduledEvent, env: Env) {
    await syncAllUsers(env);
  },
};
