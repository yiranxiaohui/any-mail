import { Hono } from "hono";
import type { Env } from "../types";
import { getOAuthCredentials } from "../settings";
import { sha256Hex, authMiddleware, getUserId, type ApiKeyContext, type UserContext } from "../auth";
import { getGmailAuthUrl, handleGmailCallback } from "../providers/gmail";
import { getOutlookAuthUrl, handleOutlookCallback, generatePkce, getOutlookPkceAuthUrl, handleOutlookPkceCallback } from "../providers/outlook";

const oauth = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKeyContext; user?: UserContext } }>();

// 在 worker 内存中维护"state -> { userId, ... }"映射，5 分钟自动清理
// 注意：Cloudflare Worker 实例可能会被回收，state 丢失则用户需要重新点击连接
interface PendingOAuth {
  userId: string;
  // PKCE-specific
  codeVerifier?: string;
  clientId?: string;
}
const stateStore = new Map<string, PendingOAuth>();
function rememberState(state: string, data: PendingOAuth) {
  stateStore.set(state, data);
  setTimeout(() => stateStore.delete(state), 5 * 60 * 1000);
}
function consumeState(state: string): PendingOAuth | undefined {
  const v = stateStore.get(state);
  stateStore.delete(state);
  return v;
}

/** 备用：把 user_id 直接编码进 state，签名后传到第三方（用于 worker 重启场景） */
async function signState(userId: string, secret: string, extra?: string): Promise<string> {
  const nonce = crypto.randomUUID();
  const payload = `${userId}:${nonce}${extra ? ":" + extra : ""}`;
  const data = btoa(payload).replace(/=+$/, "");
  const sig = await sha256Hex(`${data}.${secret}`);
  return `${data}.${sig.slice(0, 16)}`;
}
async function verifyState(state: string, secret: string): Promise<{ userId: string; extra?: string } | null> {
  const [data, sig] = state.split(".");
  if (!data || !sig) return null;
  const expected = (await sha256Hex(`${data}.${secret}`)).slice(0, 16);
  if (expected !== sig) return null;
  try {
    const payload = atob(data);
    const parts = payload.split(":");
    const userId = parts[0]!;
    const extra = parts[2];
    return { userId, extra };
  } catch {
    return null;
  }
}

// ====== 启动 OAuth（需要登录态） ======

// 必须在挂载到 /api/oauth 之前先放公开的 callback；start 路由要求登录
oauth.get("/gmail/start", authMiddleware(), async (c) => {
  const userId = getUserId(c);
  const creds = await getOAuthCredentials(c.env, userId);
  if (!creds.gmailClientId || !creds.gmailClientSecret) {
    return c.json({ error: "Gmail OAuth credentials not configured in Settings" }, 400);
  }
  const origin = new URL(c.req.url).origin;
  const state = await signState(userId, c.env.JWT_SECRET);
  return c.json({ url: getGmailAuthUrl(creds, origin, state) });
});

oauth.get("/outlook/start", authMiddleware(), async (c) => {
  const userId = getUserId(c);
  const creds = await getOAuthCredentials(c.env, userId);
  if (!creds.outlookClientId || !creds.outlookClientSecret) {
    return c.json({ error: "Outlook OAuth credentials not configured in Settings" }, 400);
  }
  const origin = new URL(c.req.url).origin;
  const state = await signState(userId, c.env.JWT_SECRET);
  return c.json({ url: getOutlookAuthUrl(creds, origin, state) });
});

oauth.get("/outlook/reauth/start", authMiddleware(), async (c) => {
  const userId = getUserId(c);
  const clientId = c.req.query("client_id");
  if (!clientId) return c.json({ error: "missing client_id" }, 400);

  const origin = new URL(c.req.url).origin;
  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = crypto.randomUUID();

  rememberState(state, { userId, codeVerifier, clientId });

  return c.json({ url: getOutlookPkceAuthUrl(clientId, origin, codeChallenge, state) });
});

// ====== Callbacks（第三方回跳，无认证） ======

oauth.get("/gmail/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const verified = await verifyState(state, c.env.JWT_SECRET);
  if (!verified) return c.json({ error: "invalid state" }, 400);

  const creds = await getOAuthCredentials(c.env, verified.userId);
  const origin = new URL(c.req.url).origin;
  try {
    const account = await handleGmailCallback(code, creds, origin, c.env.DB, verified.userId);
    return c.redirect(`${origin}/console/accounts?oauth=success&email=${encodeURIComponent(account.email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return c.redirect(`${origin}/console/accounts?oauth=error&message=${encodeURIComponent(msg)}`);
  }
});

oauth.get("/outlook/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const verified = await verifyState(state, c.env.JWT_SECRET);
  if (!verified) return c.json({ error: "invalid state" }, 400);

  const creds = await getOAuthCredentials(c.env, verified.userId);
  const origin = new URL(c.req.url).origin;
  try {
    const account = await handleOutlookCallback(code, creds, origin, c.env.DB, verified.userId);
    return c.redirect(`${origin}/console/accounts?oauth=success&email=${encodeURIComponent(account.email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return c.redirect(`${origin}/console/accounts?oauth=error&message=${encodeURIComponent(msg)}`);
  }
});

oauth.get("/outlook/pkce-callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const pending = consumeState(state);
  if (!pending?.codeVerifier || !pending.clientId) {
    return c.json({ error: "invalid or expired state" }, 400);
  }

  const origin = new URL(c.req.url).origin;
  try {
    const account = await handleOutlookPkceCallback(code, pending.clientId, pending.codeVerifier, origin, c.env.DB, pending.userId);
    return c.redirect(`${origin}/console/accounts?reauth=success&email=${encodeURIComponent(account.email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return c.redirect(`${origin}/console/accounts?reauth=error&message=${encodeURIComponent(msg)}`);
  }
});

export default oauth;
