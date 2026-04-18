import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Account } from "./types";
import { login, authMiddleware, requireJwt, requireScope, type ApiKeyContext } from "./auth";
import { handleDomainEmail } from "./providers/domain";
import { syncGmailEmails } from "./providers/gmail";
import { syncOutlookEmails } from "./providers/outlook";
import { getOAuthCredentials } from "./settings";
import emailsRoute from "./routes/emails";
import accountsRoute from "./routes/accounts";
import oauthRoute from "./routes/oauth";
import settingsRoute from "./routes/settings";
import apiKeysRoute from "./routes/api-keys";

const app = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext } }>();

app.use("/*", cors());

// 健康检查
app.get("/", (c) => c.json({ name: "any-mail", status: "ok" }));

// 登录（不需要 token）
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ password: string }>();
  const token = await login(body.password, c.env);
  if (!token) {
    return c.json({ error: "invalid password" }, 401);
  }
  return c.json({ token });
});

// OAuth 回调不需要认证（从第三方跳转回来）
app.route("/api/oauth", oauthRoute);

// 以下所有 /api/* 路由需要认证
app.use("/api/*", authMiddleware());

// 路由挂载
app.route("/api/emails", emailsRoute);
app.route("/api/accounts", accountsRoute);
app.route("/api/settings", settingsRoute);
app.route("/api/keys", apiKeysRoute);

// 公开域名列表（API key 可通过 domains:read 访问，用于外部程序发现可用域名）
app.get("/api/domains", requireScope("domains:read"), async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'EMAIL_DOMAINS'")
    .first<{ value: string }>();
  const domains = row?.value
    ? row.value.split(",").map((d) => d.trim()).filter(Boolean).map((name) => ({ name }))
    : [];
  return c.json({ domains });
});

// 手动触发同步（全部）— 仅限 JWT（管理员操作）
app.post("/api/sync", requireJwt(), async (c) => {
  const result = await syncAllAccounts(c.env);
  return c.json(result);
});

// 同步单个账号 — 要求 accounts:write（API key 若绑定 provider，会在下面校验）
app.post("/api/accounts/:id/sync", requireScope("accounts:write"), async (c) => {
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT * FROM accounts WHERE id = ?")
    .bind(id)
    .first<Account>();

  if (!account) return c.json({ error: "not found" }, 404);
  const key = c.get("apiKey");
  if (key?.provider && account.provider !== key.provider) {
    return c.json({ error: "not found" }, 404);
  }
  if (account.provider === "domain") return c.json({ error: "domain accounts receive email passively" }, 400);

  const creds = await getOAuthCredentials(c.env);
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

/** 同步所有 Gmail 和 Outlook 账号 */
async function syncAllAccounts(env: Env) {
  const creds = await getOAuthCredentials(env);
  const accounts = await env.DB.prepare(
    "SELECT * FROM accounts WHERE provider IN ('gmail', 'outlook')"
  ).all<Account>();

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

export default {
  fetch: app.fetch,

  // Cloudflare Email Worker: 接收域名邮件
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleDomainEmail(message, env);
  },

  // Cron Trigger: 定时轮询 Gmail / Outlook
  async scheduled(_event: ScheduledEvent, env: Env) {
    await syncAllAccounts(env);
  },
};
