import { afterEach, describe, expect, mock, test } from "bun:test";
import { cronBatchSize, syncAccountOnDemand, syncAccountWithState, syncDueAccounts } from "../src/sync";
import type { Account, Env } from "../src/types";
import type { OAuthCredentials } from "../src/settings";

type Recorded = { sql: string; params: unknown[] };

/** Minimal D1 stand-in: records statements and answers by SQL prefix. */
class FakeDatabase {
  statements: Recorded[] = [];
  constructor(private readonly responders: { match: RegExp; rows: unknown[] }[] = []) {}

  private rowsFor(sql: string) {
    return this.responders.find((r) => r.match.test(sql))?.rows ?? [];
  }

  prepare(sql: string) {
    const record: Recorded = { sql: sql.replace(/\s+/g, " ").trim(), params: [] };
    this.statements.push(record);
    const statement = {
      bind: (...params: unknown[]) => {
        record.params = params;
        return statement;
      },
      all: async () => ({ success: true, results: this.rowsFor(record.sql), meta: {} }),
      first: async () => this.rowsFor(record.sql)[0] ?? null,
      run: async () => ({ success: true, results: [], meta: { changes: 1 } }),
    };
    return statement;
  }

  async batch(statements: unknown[]) {
    return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  }

  find(prefix: string) {
    return this.statements.filter((s) => s.sql.startsWith(prefix));
  }
}

const creds: OAuthCredentials = {
  gmailClientId: "",
  gmailClientSecret: "",
  outlookClientId: "",
  outlookClientSecret: "",
};

function outlookAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    user_id: "user-1",
    provider: "outlook",
    email: "someone@outlook.com",
    password: null,
    client_id: "client-1",
    access_token: null,
    refresh_token: "old-refresh",
    token_expires_at: null,
    last_sync_history_id: null,
    expires_at: null,
    created_at: "2026-04-16",
    updated_at: "2026-04-16",
    ...overrides,
  };
}

function envFor(db: FakeDatabase, extra: Partial<Env> = {}): Env {
  return { DB: db as unknown as D1Database, JWT_SECRET: "test", ...extra };
}

const realFetch = globalThis.fetch;
function mockFetch(handler: (url: string) => Response) {
  const fn = mock(async (input: RequestInfo | URL) => handler(String(input)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("cronBatchSize", () => {
  test("defaults to 10 and clamps configured values", () => {
    const db = new FakeDatabase();
    expect(cronBatchSize(envFor(db))).toBe(10);
    expect(cronBatchSize(envFor(db, { SYNC_BATCH_SIZE: "25" }))).toBe(25);
    expect(cronBatchSize(envFor(db, { SYNC_BATCH_SIZE: "0" }))).toBe(10);
    expect(cronBatchSize(envFor(db, { SYNC_BATCH_SIZE: "junk" }))).toBe(10);
    expect(cronBatchSize(envFor(db, { SYNC_BATCH_SIZE: "100000" }))).toBe(200);
  });
});

describe("syncAccountWithState", () => {
  test("flags an expired refresh token as needing re-authorization", async () => {
    const db = new FakeDatabase();
    mockFetch(() => json({
      error: "invalid_grant",
      error_description: "AADSTS70000: The user could not be authenticated as the grant is expired.",
    }, 400));

    const result = await syncAccountWithState(envFor(db), outlookAccount(), creds);

    expect(result.needsReauth).toBe(true);
    expect(result.error).toContain("AADSTS70000");
    const [state] = db.find("UPDATE accounts SET last_sync_at = ?, sync_error = ?, needs_reauth = ?");
    expect(state?.params.slice(1)).toEqual([result.error, 1, "acc-1"]);
  });

  test("records transient failures without flagging re-authorization", async () => {
    const db = new FakeDatabase();
    mockFetch(() => json({ error: "temporarily_unavailable" }, 503));

    const result = await syncAccountWithState(envFor(db), outlookAccount(), creds);

    expect(result.needsReauth).toBe(false);
    const [state] = db.find("UPDATE accounts SET last_sync_at = ?, sync_error = ?, needs_reauth = ?");
    expect(state?.params[2]).toBe(0);
  });

  test("rotates the refresh token, inserts only unseen mail, and clears the error state", async () => {
    const db = new FakeDatabase([{ match: /^SELECT message_id FROM emails/, rows: [{ message_id: "m1" }] }]);
    mockFetch((url) => url.includes("/token")
      ? json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
      : json({ value: [{ id: "m1", subject: "old" }, { id: "m2", subject: "new" }] }));

    const result = await syncAccountWithState(envFor(db), outlookAccount(), creds);

    expect(result).toEqual({ synced: 1 });
    const [tokenUpdate] = db.find("UPDATE accounts SET access_token = ?, refresh_token = ?");
    expect(tokenUpdate?.params.slice(0, 2)).toEqual(["new-access", "new-refresh"]);
    const [dedupe] = db.find("SELECT message_id FROM emails");
    expect(dedupe?.params).toEqual(["acc-1", "m1", "m2"]);
    const inserts = db.find("INSERT OR IGNORE INTO emails");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params[3]).toBe("m2");
    expect(db.find("UPDATE accounts SET last_sync_at = ?, sync_error = NULL, needs_reauth = 0")).toHaveLength(1);
  });

  test("surfaces Graph API errors instead of silently reporting zero mail", async () => {
    const db = new FakeDatabase();
    mockFetch(() => json({ error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } }, 401));

    const result = await syncAccountWithState(
      envFor(db),
      outlookAccount({ access_token: "cached", token_expires_at: Date.now() + 3_600_000 }),
      creds,
    );

    expect(result.error).toBe("Graph API 401: Access token has expired.");
    expect(result.needsReauth).toBe(false);
  });
});

describe("syncDueAccounts", () => {
  test("syncs the least-recently-synced healthy accounts within the batch size", async () => {
    const accounts = [outlookAccount({ id: "a" }), outlookAccount({ id: "b" })];
    const db = new FakeDatabase([
      { match: /^SELECT \* FROM accounts/, rows: accounts },
      { match: /^SELECT key, value FROM user_settings/, rows: [] },
    ]);
    const fetchMock = mockFetch((url) => url.includes("/token")
      ? json({ access_token: "t", expires_in: 3600 })
      : json({ value: [] }));

    const processed = await syncDueAccounts(envFor(db, { SYNC_BATCH_SIZE: "2" }));

    expect(processed).toBe(2);
    const [queue] = db.find("SELECT * FROM accounts");
    expect(queue?.sql).toContain("needs_reauth = 0");
    expect(queue?.sql).toContain("ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC");
    expect(queue?.params.at(-1)).toBe(2);
    // Credentials are loaded once per user, not once per account.
    expect(db.find("SELECT key, value FROM user_settings")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("syncAccountOnDemand", () => {
  test("syncs the exact mailbox when it is due", async () => {
    const db = new FakeDatabase([
      { match: /^SELECT \* FROM accounts/, rows: [outlookAccount()] },
      { match: /^SELECT key, value FROM user_settings/, rows: [] },
    ]);
    const fetchMock = mockFetch((url) => url.includes("/token")
      ? json({ access_token: "t", expires_in: 3600 })
      : json({ value: [] }));

    await syncAccountOnDemand(envFor(db), "user-1", " Someone@Outlook.com ", "outlook");

    const [lookup] = db.find("SELECT * FROM accounts");
    expect(lookup?.sql).toContain("email = ? COLLATE NOCASE");
    expect(lookup?.sql).toContain("last_sync_at IS NULL OR last_sync_at < ?");
    expect(lookup?.params[1]).toBe("Someone@Outlook.com");
    expect(lookup?.params.at(-1)).toBe("outlook");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does nothing when no due account matches", async () => {
    const db = new FakeDatabase();
    const fetchMock = mockFetch(() => json({}));

    await syncAccountOnDemand(envFor(db), "user-1", "someone@outlook.com", null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.statements).toHaveLength(1);
  });
});
