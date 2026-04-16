import { Hono } from "hono";
import type { Env } from "../types";
import { getOAuthCredentials } from "../settings";
import { getGmailAuthUrl, handleGmailCallback } from "../providers/gmail";
import { getOutlookAuthUrl, handleOutlookCallback } from "../providers/outlook";

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

export default oauth;
