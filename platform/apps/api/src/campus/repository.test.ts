import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type {
  CampusDataByKind,
  CampusKind,
} from "./contracts.js";
import {
  CAMPUS_SQL_SCHEMA,
  CampusUserConflictError,
  LAUNDRY_QUEUE_TERMINAL_HISTORY_LIMIT,
  LAUNDRY_QUEUE_TERMINAL_HISTORY_WINDOW_MS,
  SqliteCampusRepository,
  SqliteCampusUserRepository,
} from "./repository.js";
import { CampusCollectorService } from "./service.js";
import type {
  CampusDataSource,
  CampusSourceResponse,
} from "./source.js";
import { laundryFixture, mealsFixture } from "./test-fixtures.js";

describe("campus SQLite repositories", () => {
  it("keeps the last-good snapshot and marks it stale after failure", async () => {
    const database = testDatabase();
    const repository = new SqliteCampusRepository(database);
    let now = 1_000;
    let calls = 0;
    const source: CampusDataSource = {
      fetch: async <K extends CampusKind>(
        kind: K,
      ): Promise<CampusSourceResponse<CampusDataByKind[K]>> => {
        calls += 1;
        if (calls === 2) throw new Error("upstream secret");
        return {
          status: "modified",
          etag: '"v1"',
          checkedAtEpochMs: now,
          data: (kind === "laundry"
            ? laundryFixture()
            : mealsFixture()) as unknown as CampusDataByKind[K],
        };
      },
      fetchMealHistory: async () => ({ posts: [], nextBefore: null }),
    };
    const service = new CampusCollectorService({
      source,
      repository,
      now: () => now,
      pollIntervalMs: { laundry: 100 },
      maxAgeMs: { laundry: 1_000 },
    });

    await expect(service.refresh("laundry")).resolves.toMatchObject({
      stale: false,
      etag: '"v1"',
      data: { schemaVersion: 1 },
    });
    now = 1_100;
    await expect(service.refresh("laundry")).resolves.toMatchObject({
      stale: true,
      data: { schemaVersion: 1 },
      lastError: "Unexpected campus collection error.",
    });
    expect(repository.getSourceState("laundry")).toMatchObject({
      consecutiveFailures: 1,
      nextPollAtEpochMs: 1_200,
    });
    database.close();
  });

  it("stores user meal rules, session watches, and voluntary queue order", () => {
    const database = testDatabase();
    const users = new SqliteCampusUserRepository(database);
    users.upsertMealRule({
      userId: "user-1",
      enabled: true,
      breakfast: false,
      lunch: true,
      dinner: false,
      updatedAtEpochMs: 1_000,
    });
    expect(users.listMealSubscriberUserIds("lunch")).toEqual([
      "user-1",
    ]);
    expect(users.listMealSubscriberUserIds("dinner")).toEqual([]);

    expect(
      users.isAttendancePhaseEnabled("user-1", "morning"),
    ).toBe(false);
    users.upsertAttendanceRule({
      userId: "user-1",
      enabled: true,
      morning: true,
      evening: false,
      updatedAtEpochMs: 1_000,
    });
    expect(users.getAttendanceRule("user-1")).toMatchObject({
      enabled: true,
      morning: true,
      evening: false,
    });
    expect(
      users.isAttendancePhaseEnabled("user-1", "morning"),
    ).toBe(true);
    expect(
      users.isAttendancePhaseEnabled("user-1", "evening"),
    ).toBe(false);

    users.createWatch({
      id: "watch-1",
      userId: "user-1",
      machineId: "tower-3",
      appliance: "washer",
      sessionId: "session-1",
      notifyBeforeMinutes: 10,
      notifyWhenAvailable: true,
      status: "active",
      createdAtEpochMs: 1_000,
      updatedAtEpochMs: 1_000,
    });
    expect(
      users.listActiveWatches({
        machineId: "tower-3",
        appliance: "washer",
        sessionId: "session-1",
      }),
    ).toHaveLength(1);

    const first = users.enqueue({
      id: "queue-1",
      userId: "user-1",
      machineId: "tower-3",
      appliance: "washer",
      status: "waiting",
      joinedAtEpochMs: 1_000,
      leftAtEpochMs: null,
    });
    const second = users.enqueue({
      id: "queue-2",
      userId: "user-2",
      machineId: "tower-3",
      appliance: "washer",
      status: "waiting",
      joinedAtEpochMs: 1_001,
      leftAtEpochMs: null,
    });
    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(
      users.listQueue({
        machineId: "tower-3",
        appliance: "washer",
      }),
    ).toMatchObject([
      { userId: "user-1", position: 1 },
      { userId: "user-2", position: 2 },
    ]);
    expect(users.listQueueByUser("user-2", 1_001)).toMatchObject([
      {
        id: "queue-2",
        userId: "user-2",
        position: 2,
        status: "waiting",
      },
    ]);
    expect(
      users.leaveQueue(
        "queue-1",
        "user-1",
        "cancelled",
        2_000,
      ),
    ).toBe(true);
    expect(
      users.listQueue({
        machineId: "tower-3",
        appliance: "washer",
      }),
    ).toMatchObject([{ userId: "user-2", position: 1 }]);
    expect(users.listQueueByUser("user-2", 2_000)).toMatchObject([
      { id: "queue-2", position: 1 },
    ]);
    database.close();
  });

  it("keeps active positions while returning bounded recent queue outcomes", () => {
    const database = testDatabase();
    const users = new SqliteCampusUserRepository(database);
    const nowEpochMs = 100_000_000;

    users.enqueue({
      id: "queue-preceding",
      userId: "user-2",
      machineId: "tower-active",
      appliance: "washer",
      status: "waiting",
      joinedAtEpochMs: nowEpochMs - 2_000,
      leftAtEpochMs: null,
    });
    users.enqueue({
      id: "queue-active",
      userId: "user-1",
      machineId: "tower-active",
      appliance: "washer",
      status: "waiting",
      joinedAtEpochMs: nowEpochMs - 1_000,
      leftAtEpochMs: null,
    });

    const insertTerminal = database.prepare(`
      INSERT INTO laundry_voluntary_queue (
        id, user_id, machine_id, appliance, status,
        joined_at_epoch_ms, left_at_epoch_ms
      ) VALUES (
        @id, 'user-1', @machineId, 'dryer', @status,
        @joinedAtEpochMs, @leftAtEpochMs
      )
    `);
    for (
      let index = 0;
      index < LAUNDRY_QUEUE_TERMINAL_HISTORY_LIMIT + 2;
      index += 1
    ) {
      const leftAtEpochMs = nowEpochMs - (index + 1) * 1_000;
      insertTerminal.run({
        id: `queue-terminal-${index}`,
        machineId: `tower-terminal-${index}`,
        status: index % 2 === 0 ? "claimed" : "expired",
        joinedAtEpochMs: leftAtEpochMs - 100,
        leftAtEpochMs,
      });
    }
    insertTerminal.run({
      id: "queue-too-old",
      machineId: "tower-old",
      status: "expired",
      joinedAtEpochMs:
        nowEpochMs - LAUNDRY_QUEUE_TERMINAL_HISTORY_WINDOW_MS - 101,
      leftAtEpochMs:
        nowEpochMs - LAUNDRY_QUEUE_TERMINAL_HISTORY_WINDOW_MS - 1,
    });
    insertTerminal.run({
      id: "queue-cancelled",
      machineId: "tower-cancelled",
      status: "cancelled",
      joinedAtEpochMs: nowEpochMs - 200,
      leftAtEpochMs: nowEpochMs - 100,
    });

    const entries = users.listQueueByUser("user-1", nowEpochMs);
    expect(entries[0]).toMatchObject({
      id: "queue-active",
      status: "waiting",
      position: 2,
    });
    expect(entries.slice(1)).toHaveLength(
      LAUNDRY_QUEUE_TERMINAL_HISTORY_LIMIT,
    );
    expect(entries.slice(1).map(({ id }) => id)).toEqual(
      Array.from(
        { length: LAUNDRY_QUEUE_TERMINAL_HISTORY_LIMIT },
        (_, index) => `queue-terminal-${index}`,
      ),
    );
    expect(entries.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "claimed", position: 0 }),
        expect.objectContaining({ status: "expired", position: 0 }),
      ]),
    );
    expect(entries.map(({ id }) => id)).not.toContain("queue-too-old");
    expect(entries.map(({ id }) => id)).not.toContain(
      "queue-cancelled",
    );
    database.close();
  });

  it("enforces active watch uniqueness in SQLite", () => {
    const database = testDatabase();
    const users = new SqliteCampusUserRepository(database);
    const first = {
      id: "watch-1",
      userId: "user-1",
      machineId: "tower-3",
      appliance: "washer" as const,
      sessionId: "session-1",
      notifyBeforeMinutes: 10,
      notifyWhenAvailable: false,
      status: "active" as const,
      createdAtEpochMs: 1_000,
      updatedAtEpochMs: 1_000,
    };
    users.createWatch(first);
    expect(() =>
      users.createWatch({
        ...first,
        id: "watch-2",
        notifyBeforeMinutes: 20,
      }),
    ).toThrow(
      new CampusUserConflictError("LAUNDRY_WATCH_ALREADY_EXISTS"),
    );
    expect(() =>
      users.createWatch({
        ...first,
        id: "watch-available",
        notifyWhenAvailable: true,
      }),
    ).not.toThrow();
    database.close();
  });

  it("blocks queue rejoin only while waiting or an unexpired claim is active", () => {
    const database = testDatabase();
    const users = new SqliteCampusUserRepository(database);
    const base = {
      userId: "user-1",
      machineId: "tower-3",
      appliance: "washer" as const,
      status: "waiting" as const,
      leftAtEpochMs: null,
    };
    users.enqueue({
      ...base,
      id: "queue-1",
      joinedAtEpochMs: 1_000,
    });
    expect(
      users.claimWaitingQueueHead({
        machineId: "tower-3",
        appliance: "washer",
        claimedAtEpochMs: 1_100,
        expiresAtEpochMs: 2_000,
      }),
    ).toMatchObject({ id: "queue-1", status: "claimed" });
    expect(() =>
      users.enqueue({
        ...base,
        id: "queue-too-early",
        joinedAtEpochMs: 1_999,
      }),
    ).toThrow(
      new CampusUserConflictError("LAUNDRY_QUEUE_ALREADY_JOINED"),
    );
    expect(() =>
      users.enqueue({
        ...base,
        id: "queue-after-expiry",
        joinedAtEpochMs: 2_000,
      }),
    ).not.toThrow();
    expect(users.expireQueueClaims(2_000)).toBe(1);
    expect(users.getQueueEntry("queue-1")).toMatchObject({
      status: "expired",
    });
    database.close();
  });
});

function testDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(CAMPUS_SQL_SCHEMA);
  return database;
}
