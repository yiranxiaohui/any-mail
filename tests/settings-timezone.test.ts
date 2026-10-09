import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ApiKeyContext, UserContext } from "../src/auth";
import settingsRoute from "../src/routes/settings";
import type { Env } from "../src/types";

// Execute the route's SQL against SQLite to verify persistence and user isolation.
function createDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE user_settings (user_id TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (user_id, key))");
  sqlite.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  const db = {
    prepare(sql: string) {
      let params: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) { params = values; return statement; },
        all: async () => ({ results: sqlite.query(sql).all(...params) }),
        run: async () => sqlite.query(sql).run(...params),
      };
      return statement;
    },
    batch: async (statements: { run(): Promise<unknown> }[]) => Promise.all(statements.map((s) => s.run())),
  };
  return { db: db as unknown as D1Database, sqlite };
}

function createApp(db: D1Database, user: UserContext, apiKey = false) {
  const app = new Hono<{ Bindings: Env; Variables: { user?: UserContext; apiKey?: ApiKeyContext } }>();
  app.use("/*", async (c, next) => {
    c.set("user", user);
    if (apiKey) c.set("apiKey", { id: "key", user_id: user.id, scopes: ["*"], provider: null, address: null, expires_at: null });
    await next();
  });
  app.route("/", settingsRoute);
  const env = { DB: db, JWT_SECRET: "test" };
  return {
    get: () => app.request("/", {}, env),
    put: (body: unknown) => app.request("/", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, env),
  };
}

describe("user time zone settings", () => {
  test("defaults to UTC+8 and persists an ordinary user's choice independently", async () => {
    const { db, sqlite } = createDatabase();
    const alice = createApp(db, { id: "alice", role: "user" });
    const bob = createApp(db, { id: "bob", role: "user" });
    expect((await (await alice.get()).json()).settings.TIME_ZONE.value).toBe("Asia/Shanghai");
    expect((await alice.put({ TIME_ZONE: "America/New_York" })).status).toBe(200);
    // A new client for the same user reads the persisted choice.
    expect((await (await createApp(db, { id: "alice", role: "user" }).get()).json()).settings.TIME_ZONE.value).toBe("America/New_York");
    expect((await (await bob.get()).json()).settings.TIME_ZONE.value).toBe("Asia/Shanghai");
    expect((await bob.put({ TIME_ZONE: "UTC" })).status).toBe(200);
    expect((await (await alice.get()).json()).settings.TIME_ZONE.value).toBe("America/New_York");
    sqlite.close();
  });

  test("rejects invalid zones before applying any settings in the same request", async () => {
    const { db, sqlite } = createDatabase();
    const client = createApp(db, { id: "alice", role: "user" });
    for (const TIME_ZONE of ["", "UTC+8", "Invalid/Zone", null, 8]) {
      expect((await client.put({ RESEND_API_KEY: "test-key", TIME_ZONE })).status).toBe(400);
    }
    expect(sqlite.query("SELECT * FROM user_settings").all()).toHaveLength(0);
    sqlite.close();
  });

  test("stores the administrator's zone as a user preference and keeps system settings restricted", async () => {
    const { db, sqlite } = createDatabase();
    const admin = createApp(db, { id: "admin", role: "admin" });
    const alice = createApp(db, { id: "alice", role: "user" });
    expect((await admin.put({ TIME_ZONE: "UTC" })).status).toBe(200);
    expect(sqlite.query("SELECT * FROM settings").all()).toHaveLength(0);
    expect((await alice.put({ TIME_ZONE: "UTC", SHARED_INBOX_DOMAIN: "example.test" })).status).toBe(403);
    expect((await (await alice.get()).json()).settings.TIME_ZONE.value).toBe("Asia/Shanghai");
    sqlite.close();
  });

  test("continues rejecting API key access to settings", async () => {
    const { db, sqlite } = createDatabase();
    const client = createApp(db, { id: "alice", role: "user" }, true);
    expect((await client.get()).status).toBe(403);
    expect((await client.put({ TIME_ZONE: "UTC" })).status).toBe(403);
    sqlite.close();
  });
});
