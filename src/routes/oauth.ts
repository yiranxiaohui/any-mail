import { Hono } from "hono";
import type { Env } from "../types";
import { getOAuthCredentials } from "../settings";
import { getGmailAuthUrl, handleGmailCallback } from "../providers/gmail";
import { getOutlookAuthUrl, handleOutlookCallback, generatePkce, getOutlookPkceAuthUrl, handleOutlookPkceCallback } from "../providers/outlook";

const oauth = new Hono<{ Bindings: Env }>();

// ====== Gmail ======

oauth.get("/gmail", async (c) => {
  const creds = await getOAuthCredentials(c.env);
  const origin = new URL(c.req.url).origin;
  return c.redirect(getGmailAuthUrl(creds, origin));
});

oauth.get("/gmail/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "missing code" }, 400);

  const creds = await getOAuthCredentials(c.env);
  const origin = new URL(c.req.url).origin;
  const account = await handleGmailCallback(code, creds, origin, c.env.DB);
  return c.json({ ok: true, account: { id: account.id, email: account.email, provider: "gmail" } });
});

// ====== Outlook ======

oauth.get("/outlook", async (c) => {
  const creds = await getOAuthCredentials(c.env);
  const origin = new URL(c.req.url).origin;
  return c.redirect(getOutlookAuthUrl(creds, origin));
});

oauth.get("/outlook/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "missing code" }, 400);

  const creds = await getOAuthCredentials(c.env);
  const origin = new URL(c.req.url).origin;
  const account = await handleOutlookCallback(code, creds, origin, c.env.DB);
  return c.json({ ok: true, account: { id: account.id, email: account.email, provider: "outlook" } });
});

// ====== Outlook PKCE (用账号自带 client_id 重新授权) ======

// 临时存储 code_verifier（Worker 无 session，用 KV 会更好，这里用内存 Map 简化）
const pkceStore = new Map<string, { codeVerifier: string; clientId: string }>();

oauth.get("/outlook/reauth", async (c) => {
  const clientId = c.req.query("client_id");
  if (!clientId) return c.json({ error: "missing client_id" }, 400);

  const origin = new URL(c.req.url).origin;
  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = crypto.randomUUID();

  pkceStore.set(state, { codeVerifier, clientId });
  // 5 分钟后清理
  setTimeout(() => pkceStore.delete(state), 5 * 60 * 1000);

  return c.redirect(getOutlookPkceAuthUrl(clientId, origin, codeChallenge, state));
});

oauth.get("/outlook/pkce-callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const pkceData = pkceStore.get(state);
  if (!pkceData) return c.json({ error: "invalid or expired state" }, 400);
  pkceStore.delete(state);

  const origin = new URL(c.req.url).origin;
  try {
    const account = await handleOutlookPkceCallback(code, pkceData.clientId, pkceData.codeVerifier, origin, c.env.DB);
    // 授权成功，重定向回前端账户页
    return c.redirect(`${origin}/accounts?reauth=success&email=${encodeURIComponent(account.email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return c.redirect(`${origin}/accounts?reauth=error&message=${encodeURIComponent(msg)}`);
  }
});

export default oauth;
