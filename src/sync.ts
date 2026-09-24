import type { Account, Env } from "./types";
import type { OAuthCredentials } from "./settings";
import { getOAuthCredentials } from "./settings";
import { syncGmailEmails } from "./providers/gmail";
import { syncOutlookEmails } from "./providers/outlook";
import { ReauthRequiredError } from "./errors";

/**
 * Accounts polled per cron invocation. Workers Free allows 50 subrequests and
 * 50 D1 queries per invocation; one Outlook account costs up to 2 fetches and
 * 4 queries, so the default keeps a safety margin. The queue rotates by
 * least-recently-synced so every account's refresh token keeps being renewed.
 */
const DEFAULT_CRON_BATCH_SIZE = 10;
const MAX_CRON_BATCH_SIZE = 200;

export function cronBatchSize(env: Env): number {
  const parsed = Number.parseInt(env.SYNC_BATCH_SIZE ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CRON_BATCH_SIZE;
  return Math.min(parsed, MAX_CRON_BATCH_SIZE);
}

/** Sync one Gmail/Outlook account and persist its sync state. Never throws. */
export async function syncAccountWithState(
  env: Env,
  account: Account,
  creds: OAuthCredentials,
): Promise<{ synced: number; error?: string; needsReauth?: boolean }> {
  const now = Date.now();
  try {
    let synced = 0;
    if (account.provider === "gmail") {
      synced = await syncGmailEmails(account, creds, env.DB);
    } else if (account.provider === "outlook") {
      synced = await syncOutlookEmails(account, creds, env.DB);
    }
    await env.DB.prepare(
      "UPDATE accounts SET last_sync_at = ?, sync_error = NULL, needs_reauth = 0 WHERE id = ?"
    ).bind(now, account.id).run();
    return { synced };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500) || "unknown error";
    const needsReauth = err instanceof ReauthRequiredError;
    try {
      await env.DB.prepare(
        "UPDATE accounts SET last_sync_at = ?, sync_error = ?, needs_reauth = ? WHERE id = ?"
      ).bind(now, message, needsReauth ? 1 : 0, account.id).run();
    } catch {
      // Recording state is best-effort; e.g. the invocation may be out of D1 queries.
    }
    return { synced: 0, error: message, needsReauth };
  }
}

/**
 * Cron: sync the least-recently-synced healthy OAuth accounts across all users.
 * Accounts that need re-authorization are skipped so they do not consume budget.
 */
export async function syncDueAccounts(env: Env): Promise<number> {
  const nowIso = new Date().toISOString();
  const batch = await env.DB.prepare(
    `SELECT * FROM accounts
      WHERE provider IN ('gmail', 'outlook')
        AND needs_reauth = 0
        AND (expires_at IS NULL OR expires_at >= ?)
      ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
      LIMIT ?`
  ).bind(nowIso, cronBatchSize(env)).all<Account>();

  const credsByUser = new Map<string, OAuthCredentials>();
  let processed = 0;
  for (const account of batch.results) {
    let creds = credsByUser.get(account.user_id);
    if (!creds) {
      creds = await getOAuthCredentials(env, account.user_id);
      credsByUser.set(account.user_id, creds);
    }
    await syncAccountWithState(env, account, creds);
    processed++;
  }
  return processed;
}

/** Minimum interval between on-demand syncs of the same account. */
const ON_DEMAND_MIN_INTERVAL_MS = 15_000;

/**
 * Sync a single OAuth account before serving a read, so code-polling clients
 * see new mail without waiting for the account's turn in the cron rotation.
 */
export async function syncAccountOnDemand(
  env: Env,
  userId: string,
  email: string,
  provider: string | null,
): Promise<void> {
  let sql = `SELECT * FROM accounts
    WHERE user_id = ? AND email = ? COLLATE NOCASE
      AND provider IN ('gmail', 'outlook') AND needs_reauth = 0
      AND (last_sync_at IS NULL OR last_sync_at < ?)`;
  const params: (string | number)[] = [userId, email.trim(), Date.now() - ON_DEMAND_MIN_INTERVAL_MS];
  if (provider) {
    sql += " AND provider = ?";
    params.push(provider);
  }
  const account = await env.DB.prepare(sql + " LIMIT 1").bind(...params).first<Account>();
  if (!account) return;
  const creds = await getOAuthCredentials(env, userId);
  await syncAccountWithState(env, account, creds);
}
