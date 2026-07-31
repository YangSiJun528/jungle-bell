import { describe, expect, it, vi } from "vitest";

import {
  laundryResponseSchema,
  type LaundryWatch,
} from "../campus/contracts.js";
import {
  SqliteCampusRepository,
  SqliteCampusUserRepository,
} from "../campus/repository.js";
import { laundryFixture } from "../campus/test-fixtures.js";
import { openSqliteDatabase } from "../infra/sqlite/database.js";
import {
  LAUNDRY_QUEUE_CLAIM_TTL_MS,
  SqliteLaundryNotificationLifecycle,
} from "./laundry-lifecycle.js";
import { ServerNotificationPlanner } from "./planner.js";
import { SqliteNotificationRepository } from "./repository.js";

describe("SQLite laundry notification lifecycle", () => {
  it("atomically completes a session watch with its durable notification", () => {
    const fixture = lifecycleFixture(1_000);
    fixture.rules.createWatch(
      watch("watch-session", "user-session", "session-1"),
    );
    fixture.rules.createWatch(
      watch("watch-available", "user-available", null),
    );

    expect(
      fixture.lifecycle.record(
        transition({
          sourceEventId: "completed-1",
          sessionId: "session-1",
          currentState: "COMPLETED",
        }),
      ),
    ).toEqual({ planned: 1, inserted: 1 });
    expect(
      fixture.rules.listWatchesByUser("user-session")[0],
    ).toMatchObject({ status: "completed" });
    expect(
      fixture.rules.listWatchesByUser("user-available")[0],
    ).toMatchObject({ status: "active" });
    expect(
      fixture.database
        .prepare(`
          SELECT user_id, kind
          FROM notification_events
          ORDER BY user_id
        `)
        .all(),
    ).toEqual([
      {
        user_id: "user-session",
        kind: "laundry-completed",
      },
    ]);
    expect(
      fixture.database
        .prepare("SELECT status FROM notification_outbox")
        .get(),
    ).toEqual({ status: "pending" });
    expect(
      fixture.lifecycle.record(
        transition({
          sourceEventId: "completed-repeat",
          sessionId: "session-1",
          currentState: "COMPLETED",
        }),
      ),
    ).toEqual({ planned: 0, inserted: 0 });
    fixture.database.close();
  });

  it("rolls back an inserted event if the watch transition fails", () => {
    const fixture = lifecycleFixture(1_000);
    fixture.rules.createWatch(
      watch("watch-session", "user-session", "session-1"),
    );
    vi.spyOn(
      fixture.rules,
      "completeActiveWatches",
    ).mockImplementation(() => {
      throw new Error("forced lifecycle failure");
    });

    expect(() =>
      fixture.lifecycle.record(
        transition({
          sourceEventId: "completed-rollback",
          sessionId: "session-1",
          currentState: "COMPLETED",
        }),
      ),
    ).toThrow("forced lifecycle failure");
    expect(
      fixture.rules.listWatchesByUser("user-session")[0],
    ).toMatchObject({ status: "active" });
    expect(
      fixture.database
        .prepare("SELECT count(*) AS count FROM notification_events")
        .get(),
    ).toEqual({ count: 0 });
    fixture.database.close();
  });

  it("claims only the queue head and passes after the claim TTL", () => {
    let now = 1_000;
    const fixture = lifecycleFixture(() => now);
    fixture.campus.saveSuccess({
      kind: "laundry",
      etag: '"available"',
      contentSha256: "a".repeat(64),
      data: availableLaundry(),
      checkedAtEpochMs: now,
      nextPollAtEpochMs: now + 60_000,
    });
    for (const [id, userId, joinedAtEpochMs] of [
      ["queue-1", "user-1", 900],
      ["queue-2", "user-2", 901],
    ] as const) {
      fixture.rules.enqueue({
        id,
        userId,
        machineId: "tower-3",
        appliance: "washer",
        status: "waiting",
        joinedAtEpochMs,
        leftAtEpochMs: null,
      });
    }

    expect(
      fixture.lifecycle.record(
        transition({
          sourceEventId: "became-available",
          sessionId: null,
          currentState: "AVAILABLE",
        }),
      ),
    ).toEqual({ planned: 1, inserted: 1 });
    expect(fixture.rules.getQueueEntry("queue-1")).toMatchObject({
      status: "claimed",
    });
    expect(fixture.rules.getQueueEntry("queue-2")).toMatchObject({
      status: "waiting",
      position: 1,
    });

    now = 1_000 + LAUNDRY_QUEUE_CLAIM_TTL_MS - 1;
    expect(fixture.lifecycle.runDue(now)).toEqual({
      planned: 0,
      inserted: 0,
    });
    now += 1;
    expect(fixture.lifecycle.runDue(now)).toEqual({
      planned: 1,
      inserted: 1,
    });
    expect(fixture.rules.getQueueEntry("queue-1")).toMatchObject({
      status: "expired",
    });
    expect(fixture.rules.getQueueEntry("queue-2")).toMatchObject({
      status: "claimed",
    });
    expect(
      fixture.database
        .prepare(`
          SELECT user_id
          FROM notification_events
          WHERE kind = 'laundry-available'
          ORDER BY created_at_epoch_ms, user_id
        `)
        .all(),
    ).toEqual([{ user_id: "user-1" }, { user_id: "user-2" }]);
    fixture.database.close();
  });
});

function lifecycleFixture(now: number | (() => number)) {
  const clock = typeof now === "function" ? now : () => now;
  const database = openSqliteDatabase(":memory:");
  const campus = new SqliteCampusRepository(database);
  const rules = new SqliteCampusUserRepository(database);
  const notifications = new SqliteNotificationRepository(database);
  const planner = new ServerNotificationPlanner(rules);
  const lifecycle = new SqliteLaundryNotificationLifecycle({
    database,
    campus,
    rules,
    planner,
    notifications,
    now: clock,
  });
  return {
    database,
    campus,
    rules,
    notifications,
    planner,
    lifecycle,
  };
}

function watch(
  id: string,
  userId: string,
  sessionId: string | null,
): LaundryWatch {
  return {
    id,
    userId,
    machineId: "tower-3",
    appliance: "washer",
    sessionId,
    notifyBeforeMinutes: 10,
    notifyWhenAvailable: sessionId === null,
    status: "active",
    createdAtEpochMs: 500,
    updatedAtEpochMs: 500,
  };
}

function transition(input: {
  readonly sourceEventId: string;
  readonly sessionId: string | null;
  readonly currentState: "COMPLETED" | "AVAILABLE";
}) {
  return {
    kind: "laundry-transition",
    sourceEventId: input.sourceEventId,
    machineId: "tower-3",
    appliance: "washer",
    sessionId: input.sessionId,
    previousState: "BUSY",
    currentState: input.currentState,
    remainingMinutes: 0,
    occurredAtEpochMs: 1_000,
  } as const;
}

function availableLaundry() {
  return laundryResponseSchema.parse({
    ...laundryFixture(),
    machines: [
      {
        id: "tower-3",
        washer: {
          machineId: "tower-3",
          appliance: "washer",
          observedAt: "2026-07-31T00:00:00.000Z",
          state: { code: "IDLE", raw: "IDLE", known: true },
          operationalStatus: "IDLE",
          remainingMinutes: 0,
          totalMinutes: 0,
          startedAt: "2026-07-31T00:00:00.000Z",
          estimatedFinishAt: null,
          remoteControlEnabled: false,
          cycleCount: 1,
          sessionId: null,
          errorCode: null,
          projection: {
            asOf: "2026-07-31T00:00:00.000Z",
            remainingMinutes: 0,
            status: "IDLE",
            estimated: false,
          },
        },
        dryer: null,
      },
    ],
  });
}
