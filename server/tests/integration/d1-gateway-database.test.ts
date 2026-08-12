import { describe, expect, it, vi } from "vitest";
import { handleD1Gateway } from "../../apps/api-worker/src/storage/cloudflare/d1-gateway";
import { D1GatewayDatabase } from "../../apps/jobs-runner/src/storage/d1-gateway-database";

function response(results: unknown[]): Response {
  return Response.json({ results });
}

describe("D1GatewayDatabase", () => {
  it("adapts prepare/bind/all, first and run to the internal HTTPS gateway", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ success: true, results: [{ id: "one" }, { id: "two" }], meta: { changes: 0 } }]))
      .mockResolvedValueOnce(response([{ success: true, results: [{ count: 2 }], meta: { changes: 0 } }]))
      .mockResolvedValueOnce(response([{ success: true, results: [], meta: { changes: 1, last_row_id: 7 } }]));
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1",
      sharedSecret: "s".repeat(64),
      requestRetries: 0,
    }, { fetch: fetchMock });

    await expect(db.prepare("SELECT id FROM item WHERE kind = ?").bind("meal").all<{ id: string }>())
      .resolves.toMatchObject({ success: true, results: [{ id: "one" }, { id: "two" }] });
    await expect(db.prepare("SELECT count(*) AS count FROM item").first<number>("count"))
      .resolves.toBe(2);
    await expect(db.prepare("DELETE FROM item WHERE id = ?").bind("one").run())
      .resolves.toMatchObject({ success: true, meta: { changes: 1, last_row_id: 7 } });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.test/internal/jobs/d1");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${"s".repeat(64)}`,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sql: "SELECT id FROM item WHERE kind = ?",
      params: ["meal"],
    });
  });

  it("sends a batch in one HTTPS request and preserves result order", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response([
      { success: true, results: [], meta: { changes: 1 } },
      { success: true, results: [{ id: "kept" }], meta: { changes: 0 } },
    ]));
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1", sharedSecret: "s".repeat(64), requestRetries: 0,
    }, { fetch: fetchMock });

    const results = await db.batch([
      db.prepare("INSERT INTO item(id) VALUES (?)").bind("kept"),
      db.prepare("SELECT id FROM item WHERE id = ?").bind("kept"),
    ]);

    expect(results[0]?.meta.changes).toBe(1);
    expect(results[1]?.results).toEqual([{ id: "kept" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ batch: [
      { sql: "INSERT INTO item(id) VALUES (?)", params: ["kept"] },
      { sql: "SELECT id FROM item WHERE id = ?", params: ["kept"] },
    ] });
  });

  it("does not mix statements from another gateway target", async () => {
    const first = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1", sharedSecret: "a".repeat(64), requestRetries: 0,
    });
    const second = new D1GatewayDatabase({
      url: "https://api-test.test/internal/jobs/d1", sharedSecret: "b".repeat(64), requestRetries: 0,
    });

    await expect(first.batch([second.prepare("DELETE FROM item")])).rejects.toThrow("same adapter");
  });

  it("does not replay a permanent D1 execution failure", async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { error: "D1_EXECUTION_FAILED" },
      { status: 422 },
    ));
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1",
      sharedSecret: "s".repeat(64),
      requestRetries: 3,
    }, { fetch: fetchMock });

    await expect(db.prepare("SELECT * FROM missing").all()).rejects.toThrow("HTTP 422");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "an ambiguous server failure",
      failure: async () => Response.json({ error: "TEMPORARY" }, { status: 503 }),
      expected: "HTTP 503",
    },
    {
      name: "an ambiguous network failure",
      failure: () => Promise.reject(new TypeError("connection reset")),
      expected: "connection reset",
    },
  ])("never replays a write after $name", async ({ failure, expected }) => {
    const fetchMock = vi.fn(failure);
    const sleep = vi.fn(async () => undefined);
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1",
      sharedSecret: "s".repeat(64),
      requestRetries: 3,
    }, { fetch: fetchMock, sleep });

    await expect(db.prepare("UPDATE item SET value = ? WHERE id = ?").bind("new", "one").run())
      .rejects.toThrow(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never replays a batch when any statement can write", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "TEMPORARY" }, { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1",
      sharedSecret: "s".repeat(64),
      requestRetries: 3,
    }, { fetch: fetchMock, sleep });

    await expect(db.batch([
      db.prepare("SELECT id FROM item"),
      db.prepare("INSERT INTO audit_log(id) VALUES (?)").bind("one"),
    ])).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never replays a repository CTE write after an ambiguous failure", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "TEMPORARY" }, { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1",
      sharedSecret: "s".repeat(64),
      requestRetries: 3,
    }, { fetch: fetchMock, sleep });

    await expect(db.prepare(`WITH planned AS (SELECT value FROM json_each(?))
      INSERT INTO notification(id) SELECT value FROM planned`).bind('["one"]').run())
      .rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a direct read whose replay is safe", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "TEMPORARY" }, { status: 503 }))
      .mockResolvedValueOnce(response([{
        success: true,
        results: [{ id: "one" }],
        meta: { changes: 0 },
      }]));
    const sleep = vi.fn(async () => undefined);
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1",
      sharedSecret: "s".repeat(64),
      requestRetries: 3,
    }, { fetch: fetchMock, sleep });

    await expect(db.prepare("SELECT id FROM item").all()).resolves.toMatchObject({
      results: [{ id: "one" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("passes repository CTE writes through the authenticated gateway", async () => {
    const statement = { bind: () => statement, run: async () => ({ success: true, results: [], meta: { changes: 1 } }) };
    const database = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async (statements: Array<{ run(): Promise<unknown> }>) =>
        Promise.all(statements.map((item) => item.run()))),
    } as unknown as D1Database;
    const secret = "s".repeat(64);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handleD1Gateway(new Request(input, init), { DB: database, JOBS_D1_GATEWAY_SECRET: secret }));
    const db = new D1GatewayDatabase({
      url: "https://api.test/internal/jobs/d1", sharedSecret: secret, requestRetries: 0,
    }, { fetch: fetchMock });

    await expect(db.batch([
      db.prepare("WITH target AS (SELECT value FROM json_each(?)) SELECT value FROM target").bind('["one"]'),
      db.prepare(`WITH planned AS (SELECT value FROM json_each(?))
        INSERT INTO notification(id) SELECT value FROM planned`).bind('["one"]'),
      db.prepare(`WITH result AS (SELECT value FROM json_each(?))
        UPDATE notification_delivery SET status = 'failed' WHERE id IN (SELECT value FROM result)`)
        .bind('["one"]'),
    ])).resolves.toHaveLength(3);
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.prepare).toHaveBeenCalledTimes(3);
  });
});
