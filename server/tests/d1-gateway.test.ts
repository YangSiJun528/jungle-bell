import { describe, expect, it, vi } from "vitest";
import {
  D1_GATEWAY_MAX_BODY_BYTES,
  handleD1Gateway,
} from "../src/workers/d1-gateway";

const secret = "s".repeat(64);

function request(body: unknown, authorization = `Bearer ${secret}`): Request {
  return new Request("https://api.test/internal/jobs/d1", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeDatabase() {
  const prepared: Array<{ sql: string; params: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => {
    const entry = { sql, params: [] as unknown[] };
    prepared.push(entry);
    const statement = {
      bind: (...params: unknown[]) => {
        entry.params = params;
        return statement;
      },
      run: async () => ({ success: true, results: [{ sql }], meta: { changes: 1 } }),
    };
    return statement;
  });
  const batch = vi.fn(async (statements: Array<{ run(): Promise<unknown> }>) =>
    Promise.all(statements.map((statement) => statement.run())));
  return { db: { prepare, batch } as unknown as D1Database, prepare, batch, prepared };
}

describe("internal D1 gateway", () => {
  it("authenticates before touching DB and does not emit CORS or cacheable responses", async () => {
    const database = fakeDatabase();
    const response = await handleD1Gateway(
      request({ sql: "SELECT 1", params: [] }, `Bearer ${"x".repeat(64)}`),
      { DB: database.db, JOBS_D1_GATEWAY_SECRET: secret },
    );

    expect(response.status).toBe(401);
    expect(database.prepare).not.toHaveBeenCalled();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("executes one strict prepared statement against the fixed DB binding", async () => {
    const database = fakeDatabase();
    const response = await handleD1Gateway(
      request({ sql: "SELECT id FROM item WHERE kind = ?", params: ["meal"] }),
      { DB: database.db, JOBS_D1_GATEWAY_SECRET: secret },
    );

    expect(response.status).toBe(200);
    expect(database.prepared).toEqual([{ sql: "SELECT id FROM item WHERE kind = ?", params: ["meal"] }]);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ success: true, results: [{ sql: "SELECT id FROM item WHERE kind = ?" }] }],
    });
  });

  it("uses DB.batch once so a submitted batch keeps D1 transaction semantics", async () => {
    const database = fakeDatabase();
    const response = await handleD1Gateway(request({ batch: [
      { sql: "INSERT INTO item(id) VALUES (?)", params: ["one"] },
      { sql: "UPDATE item SET id = ? WHERE id = ?", params: ["two", "one"] },
    ] }), { DB: database.db, JOBS_D1_GATEWAY_SECRET: secret });

    expect(response.status).toBe(200);
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.prepared).toEqual([
      { sql: "INSERT INTO item(id) VALUES (?)", params: ["one"] },
      { sql: "UPDATE item SET id = ? WHERE id = ?", params: ["two", "one"] },
    ]);
    await expect(response.json()).resolves.toMatchObject({ results: [{ success: true }, { success: true }] });
  });

  it.each([
    [{ sql: "DROP TABLE app_session", params: [] }],
    [{ sql: "SELECT 1; DELETE FROM app_session", params: [] }],
    [{ sql: "SELECT 1", params: [], extra: true }],
    [{ batch: [] }],
  ])("rejects a dangerous or non-strict payload: %j", async (body) => {
    const database = fakeDatabase();
    const response = await handleD1Gateway(request(body), {
      DB: database.db,
      JOBS_D1_GATEWAY_SECRET: secret,
    });

    expect(response.status).toBe(400);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods and oversized bodies before parsing", async () => {
    const database = fakeDatabase();
    const get = await handleD1Gateway(new Request("https://api.test/internal/jobs/d1"), {
      DB: database.db, JOBS_D1_GATEWAY_SECRET: secret,
    });
    expect(get.status).toBe(405);

    const oversized = new Request("https://api.test/internal/jobs/d1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "content-length": String(D1_GATEWAY_MAX_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect((await handleD1Gateway(oversized, {
      DB: database.db, JOBS_D1_GATEWAY_SECRET: secret,
    })).status).toBe(413);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("rejects requests above the D1 Free query and bound-parameter limits", async () => {
    const database = fakeDatabase();
    const tooManyStatements = await handleD1Gateway(request({
      batch: Array.from({ length: 51 }, () => ({ sql: "SELECT 1", params: [] })),
    }), { DB: database.db, JOBS_D1_GATEWAY_SECRET: secret });
    const tooManyParams = await handleD1Gateway(request({
      sql: `SELECT ${Array.from({ length: 101 }, () => "?").join(", ")}`,
      params: Array.from({ length: 101 }, (_, index) => index),
    }), { DB: database.db, JOBS_D1_GATEWAY_SECRET: secret });

    expect(tooManyStatements.status).toBe(400);
    expect(tooManyParams.status).toBe(400);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the configured gateway secret is shorter than 32 characters", async () => {
    const database = fakeDatabase();
    const response = await handleD1Gateway(request({ sql: "SELECT 1", params: [] }, "Bearer short"), {
      DB: database.db,
      JOBS_D1_GATEWAY_SECRET: "short",
    });

    expect(response.status).toBe(503);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("returns a non-retryable status without exposing a D1 execution error", async () => {
    const statement = {
      bind: () => statement,
      run: async () => { throw new Error("no such table: private_name"); },
    };
    const response = await handleD1Gateway(request({ sql: "SELECT 1", params: [] }), {
      DB: { prepare: () => statement } as unknown as D1Database,
      JOBS_D1_GATEWAY_SECRET: secret,
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toBe('{"error":"D1_EXECUTION_FAILED"}');
  });
});
