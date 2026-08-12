import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { decodeMealHistoryCursor, encodeMealHistoryCursor } from "../../../shared/domain/meal-history";
import { CloudflareApiStorage } from "../src/storage/cloudflare/cloudflare-storage";

describe("CloudflareApiStorage", () => {
  it("continues after a timestamp tie without skipping meal posts", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8"));
    const insert = database.prepare(`
      INSERT INTO meal_post (
        id, kind, content_sha, title, text, pinned, published_at, updated_at,
        permalink, status, first_seen_at, last_seen_at
      ) VALUES (?, 'DAILY_MENU', ?, ?, '', 0, ?, NULL, NULL, 'published', ?, ?)
    `);
    const tiedAt = "2026-08-10T02:07:38.000Z";
    for (const [id, timestamp] of [
      ["meal-c", tiedAt],
      ["meal-b", tiedAt],
      ["meal-a", tiedAt],
      ["older", "2026-08-09T02:07:38.000Z"],
    ] as const) {
      insert.run(id, id.padEnd(64, "0"), id, timestamp, timestamp, timestamp);
    }
    const db = {
      prepare: (sql: string) => {
        let values: SQLInputValue[] = [];
        const statement = {
          bind: (...nextValues: unknown[]) => {
            values = nextValues as SQLInputValue[];
            return statement;
          },
          all: async () => ({ results: database.prepare(sql).all(...values) }),
        };
        return statement;
      },
    } as unknown as D1Database;
    const storage = new CloudflareApiStorage(db, {} as R2Bucket);

    try {
      const first = await storage.listMealPosts(null, 2);
      const cursor = decodeMealHistoryCursor(encodeMealHistoryCursor(first[1]!));
      const second = await storage.listMealPosts(cursor, 2);

      expect(first.map(({ id }) => id)).toEqual(["meal-c", "meal-b"]);
      expect(second.map(({ id }) => id)).toEqual(["meal-a", "older"]);
    } finally {
      database.close();
    }
  });

  it("loads only daily meal posts inside the requested publication range", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8"));
    const insert = database.prepare(`
      INSERT INTO meal_post (
        id, kind, content_sha, title, text, pinned, published_at, updated_at,
        permalink, status, first_seen_at, last_seen_at
      ) VALUES (?, 'DAILY_MENU', ?, ?, '', 0, ?, NULL, NULL, 'published', ?, ?)
    `);
    for (const [id, timestamp] of [
      ["june", "2026-06-30T14:59:59.000Z"],
      ["july-start", "2026-06-30T15:00:00.000Z"],
      ["july-end", "2026-07-31T14:59:59.000Z"],
      ["august", "2026-07-31T15:00:00.000Z"],
    ] as const) {
      insert.run(id, id.padEnd(64, "0"), id, timestamp, timestamp, timestamp);
    }
    const db = {
      prepare: (sql: string) => {
        let values: SQLInputValue[] = [];
        const statement = {
          bind: (...nextValues: unknown[]) => {
            values = nextValues as SQLInputValue[];
            return statement;
          },
          all: async () => ({ results: database.prepare(sql).all(...values) }),
        };
        return statement;
      },
    } as unknown as D1Database;

    try {
      const storage = new CloudflareApiStorage(db, {} as R2Bucket);
      await expect(storage.listMealPostsForRange(
        "2026-06-30T15:00:00.000Z",
        "2026-07-31T15:00:00.000Z",
      )).resolves.toMatchObject([{ id: "july-end" }, { id: "july-start" }]);
    } finally {
      database.close();
    }
  });

});
