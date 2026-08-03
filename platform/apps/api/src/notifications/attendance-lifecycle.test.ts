import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type { AttendanceSnapshotRecord } from "../infra/sqlite/index.js";
import type { DesktopDeviceRecord } from "../infra/sqlite/identity-store.js";
import {
  ServerAttendanceNotificationLifecycle,
} from "./attendance-lifecycle.js";
import type { NotificationRuleReader } from "./contracts.js";
import { ServerNotificationPlanner } from "./planner.js";
import {
  NOTIFICATION_SQL_SCHEMA,
  SqliteNotificationRepository,
} from "./repository.js";

describe("ServerAttendanceNotificationLifecycle", () => {
  it("emits a desktop-offline fallback at morning T-10", async () => {
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const lifecycle = createLifecycle({
      snapshot: null,
      devices: [],
    });

    await expect(lifecycle.collectDue(now)).resolves.toMatchObject([
      {
        sourceEventId:
          "attendance:2026-07-31:morning:before-10",
        attendanceDate: "2026-07-31",
        phase: "morning",
        slot: "before-10",
        minutesRemaining: 10,
        status: "unverified",
        reason: "desktop-offline",
        occurredAtEpochMs: now,
      },
    ]);
  });

  it("uses the prior attendance date at the evening deadline", async () => {
    const now = Date.parse("2026-08-01T04:00:00+09:00");
    const lifecycle = createLifecycle({
      snapshot: null,
      devices: [device({ lastSeenAtEpochMs: now })],
      activeSession: true,
    });

    await expect(lifecycle.collectDue(now)).resolves.toMatchObject([
      {
        sourceEventId:
          "attendance:2026-07-31:evening:deadline",
        attendanceDate: "2026-07-31",
        phase: "evening",
        slot: "deadline",
        minutesRemaining: 0,
        status: "unverified",
        reason: "snapshot-missing",
        occurredAtEpochMs: now,
      },
    ]);
  });

  it("suppresses a same-date phase once checked even after the snapshot becomes stale", async () => {
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const lifecycle = createLifecycle({
      snapshot: snapshot({
        collectedAtEpochMs: now - 24 * 60 * 60_000,
        morningChecked: true,
      }),
      devices: [],
    });

    await expect(lifecycle.collectDue(now)).resolves.toEqual([]);
  });

  it.each([
    {
      cohortStatus: "upcoming" as const,
      cohortStartDate: "2026-08-01",
      cohortEndDate: "2026-08-31",
    },
    {
      cohortStatus: "ended" as const,
      cohortStartDate: "2026-07-01",
      cohortEndDate: "2026-07-30",
    },
  ])(
    "suppresses stale $cohortStatus evidence when cohort dates prove the attendance day is inactive",
    async ({ cohortStatus, cohortStartDate, cohortEndDate }) => {
      const now = Date.parse("2026-07-31T09:50:00+09:00");
      const lifecycle = createLifecycle({
        snapshot: snapshot({
          cohortStatus,
          cohortStartDate,
          cohortEndDate,
          collectedAtEpochMs: now - 24 * 60 * 60_000,
        }),
        devices: [],
      });

      await expect(lifecycle.collectDue(now)).resolves.toEqual([]);
    },
  );

  it("uses a fresh unchecked snapshot without guessing from desktop connectivity", async () => {
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const lifecycle = createLifecycle({
      snapshot: snapshot({ collectedAtEpochMs: now }),
      devices: [],
    });

    await expect(lifecycle.collectDue(now)).resolves.toMatchObject([
      {
        status: "unchecked",
        reason: null,
        slot: "before-10",
      },
    ]);
  });

  it.each([
    {
      name: "stale snapshot",
      snapshotAgeMs: 15 * 60_000 + 1,
      state: "connected" as const,
      reason: "snapshot-stale",
    },
    {
      name: "LMS login required",
      snapshotAgeMs: null,
      state: "login-required" as const,
      reason: "login-required",
    },
  ])("classifies $name conservatively", async (input) => {
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const lifecycle = createLifecycle({
      snapshot:
        input.snapshotAgeMs === null
          ? null
          : snapshot({
              collectedAtEpochMs: now - input.snapshotAgeMs,
              morningChecked: false,
            }),
      devices: [
        device({
          lastSeenAtEpochMs: now,
          lmsSessionState: input.state,
        }),
      ],
      activeSession: true,
    });

    await expect(lifecycle.collectDue(now)).resolves.toMatchObject([
      {
        status: "unverified",
        reason: input.reason,
      },
    ]);
  });

  it("does no subscriber or snapshot reads outside reminder windows", async () => {
    const listSubscribers = vi.fn(() => ["user-1"]);
    const getLatest = vi.fn(async () => null);
    const lifecycle = createLifecycle({
      snapshot: null,
      devices: [],
      listSubscribers,
      getLatest,
    });

    await expect(
      lifecycle.collectDue(
        Date.parse("2026-07-31T12:00:00+09:00"),
      ),
    ).resolves.toEqual([]);
    expect(listSubscribers).not.toHaveBeenCalled();
    expect(getLatest).not.toHaveBeenCalled();
  });

  it("limits database scans to once per minute inside a window", async () => {
    const listSubscribers = vi.fn(() => ["user-1"]);
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const lifecycle = createLifecycle({
      snapshot: snapshot({ collectedAtEpochMs: now }),
      devices: [],
      listSubscribers,
    });

    await lifecycle.collectDue(now);
    await lifecycle.collectDue(now + 30_000);
    await lifecycle.collectDue(now + 60_000);
    expect(listSubscribers).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the same user/date/phase/slot after a process restart", async () => {
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const database = new Database(":memory:");
    database.exec(NOTIFICATION_SQL_SCHEMA);
    const rules = notificationRules();

    for (let process = 0; process < 2; process += 1) {
      const repository = new SqliteNotificationRepository(database);
      const planner = new ServerNotificationPlanner(rules);
      const events = await createLifecycle({
        snapshot: snapshot({ collectedAtEpochMs: now }),
        devices: [],
      }).collectDue(now);
      for (const event of events) {
        for (const intent of planner.plan(event)) {
          repository.enqueueIntent(intent, now);
        }
      }
    }

    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM notification_events")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});

function createLifecycle(input: {
  readonly snapshot: AttendanceSnapshotRecord | null;
  readonly devices: readonly DesktopDeviceRecord[];
  readonly activeSession?: boolean;
  readonly listSubscribers?: () => string[];
  readonly getLatest?: () => Promise<AttendanceSnapshotRecord | null>;
}): ServerAttendanceNotificationLifecycle {
  return new ServerAttendanceNotificationLifecycle({
    rules: {
      listAttendanceSubscriberUserIds:
        input.listSubscribers ?? (() => ["user-1"]),
    },
    snapshots: {
      getLatest:
        input.getLatest ?? (async () => input.snapshot),
    },
    desktopIdentities: {
      listDesktopDevices: async () => input.devices,
    },
    desktopSessions: {
      hasActiveForDevice: async () => input.activeSession ?? false,
    },
  });
}

function notificationRules(): NotificationRuleReader {
  return {
    listMealSubscriberUserIds: () => [],
    isAttendancePhaseEnabled: () => true,
    listActiveWatches: () => [],
    findWaitingQueueHead: () => null,
  };
}

function snapshot(
  overrides: Partial<AttendanceSnapshotRecord> = {},
): AttendanceSnapshotRecord {
  const collectedAtEpochMs =
    overrides.collectedAtEpochMs ??
    Date.parse("2026-07-31T09:50:00+09:00");
  return {
    userId: "user-1",
    sourceDeviceId: "desktop-1",
    attendanceDate: "2026-07-31",
    cohortId: "cohort-1",
    cohortStatus: "active",
    cohortStartDate: "2026-07-01",
    cohortEndDate: "2026-08-31",
    morningChecked: false,
    eveningChecked: false,
    collectedAtEpochMs,
    receivedAtEpochMs: collectedAtEpochMs,
    version: 1,
    ...overrides,
  };
}

function device(
  overrides: Partial<DesktopDeviceRecord> = {},
): DesktopDeviceRecord {
  return {
    userId: "user-1",
    desktopDeviceId: "desktop-1",
    registeredAtEpochMs: 1,
    lastVerifiedAtEpochMs: 1,
    lastSeenAtEpochMs: null,
    lmsSessionState: "connected",
    appVersion: null,
    ...overrides,
  };
}
