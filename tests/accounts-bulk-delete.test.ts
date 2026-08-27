import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiKeyContext, UserContext } from "../src/auth";
import accountsRoute from "../src/routes/accounts";
import type { Env } from "../src/types";

type TestVariables = { apiKey?: ApiKeyContext; user?: UserContext };

class FakeDatabase {
  statements: { sql: string; params: unknown[] }[] = [];

  prepare(sql: string) {
    const record = { sql, params: [] as unknown[] };
    this.statements.push(record);
    const statement = {
      bind: (...params: unknown[]) => {
        record.params = params;
        return statement;
      },
    };
    return statement;
  }

  async batch(statements: unknown[]) {
    return statements.map((_, index) => ({
      success: true,
      results: index % 2 === 1 ? [{ id: "account-1" }, { id: "account-2" }] : [],
      meta: { changes: index % 2 === 1 ? 6 : 4 },
    }));
  }
}

function createApp(db: FakeDatabase, provider: string | null = null) {
  const app = new Hono<{ Bindings: Env; Variables: TestVariables }>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1", role: "user" });
    if (provider) {
      c.set("apiKey", {
        id: "key-1",
        user_id: "user-1",
        scopes: ["accounts:write"],
        provider,
        address: null,
        expires_at: null,
      });
    }
    await next();
  });
  app.route("/", accountsRoute);
  return { app, env: { DB: db as unknown as D1Database, JWT_SECRET: "test" } };
}

describe("POST /bulk-delete", () => {
  test("deduplicates IDs and scopes both deletes to the current user", async () => {
    const db = new FakeDatabase();
    const { app, env } = createApp(db);

    const response = await app.request("/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [" account-1 ", "account-1", "account-2"] }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: 2 });
    expect(db.statements).toHaveLength(2);
    expect(db.statements[0]?.sql).toContain("DELETE FROM emails WHERE user_id = ?");
    expect(db.statements[0]?.sql).toContain("SELECT id FROM accounts WHERE user_id = ?");
    expect(db.statements[0]?.params).toEqual(["user-1", "user-1", "account-1", "account-2"]);
    expect(db.statements[1]?.sql).toContain("DELETE FROM accounts WHERE user_id = ?");
    expect(db.statements[1]?.sql).toContain("RETURNING id");
    expect(db.statements[1]?.params).toEqual(["user-1", "account-1", "account-2"]);
  });

  test("applies an API key provider restriction to both deletes", async () => {
    const db = new FakeDatabase();
    const { app, env } = createApp(db, "outlook");

    const response = await app.request("/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["account-1"] }),
    }, env);

    expect(response.status).toBe(200);
    expect(db.statements[0]?.sql).toContain("AND provider = ?");
    expect(db.statements[0]?.params).toEqual(["user-1", "user-1", "account-1", "outlook"]);
    expect(db.statements[1]?.sql).toContain("AND provider = ?");
    expect(db.statements[1]?.params).toEqual(["user-1", "account-1", "outlook"]);
  });

  test("rejects empty, invalid, and oversized ID lists", async () => {
    const db = new FakeDatabase();
    const { app, env } = createApp(db);

    for (const ids of [[], [""], Array.from({ length: 501 }, (_, index) => `account-${index}`)]) {
      const response = await app.request("/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }, env);
      expect(response.status).toBe(400);
    }

    expect(db.statements).toHaveLength(0);
  });
});
