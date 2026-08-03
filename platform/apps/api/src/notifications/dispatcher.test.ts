import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type {
  NotificationDelivery,
  NotificationRuleReader,
  NotificationTargetDirectory,
} from "./contracts.js";
import {
  NotificationService,
  WebPushNotificationAdapter,
  type NotificationDeliveryAdapter,
} from "./dispatcher.js";
import type { PushDeliveryCoordinator } from "../push/coordinator.js";
import { ServerNotificationPlanner } from "./planner.js";
import {
  NOTIFICATION_SQL_SCHEMA,
  SqliteNotificationRepository,
} from "./repository.js";

describe("NotificationService", () => {
  it("records one user event, fans out to devices, and leaves desktop delivery for ack", async () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    const webPush = {
      deliver: vi.fn().mockResolvedValue({ status: "delivered" }),
    } satisfies NotificationDeliveryAdapter;
    let now = 1_000;
    const service = new NotificationService({
      planner: new ServerNotificationPlanner(
        mealRules(["user-1"]),
      ),
      repository,
      targets: targets(),
      webPush,
      now: () => now,
    });
    const sourceEvent = {
      kind: "meal-published",
      sourceEventId: "post-1",
      meal: "lunch",
      serviceDate: "2026-07-31",
      contentSha: "sha-1",
      preview: "김치찌개",
      occurredAtEpochMs: 900,
    } as const;

    expect(service.record(sourceEvent)).toEqual({
      planned: 1,
      inserted: 1,
    });
    expect(service.record(sourceEvent)).toEqual({
      planned: 1,
      inserted: 0,
    });
    const result = await service.runDue();
    expect(result).toEqual({
      fannedOut: 2,
      delivered: 1,
      retried: 0,
      failed: 0,
    });
    expect(webPush.deliver).toHaveBeenCalledOnce();

    now = 1_100;
    expect(
      repository.claimDesktopInbox(
        "user-1",
        "desktop-1",
        now,
        20,
        30_000,
      ),
    ).toMatchObject([
      {
        kind: "meal-published",
        title: "오늘 중식이 올라왔어요",
      },
    ]);
    database.close();
  });

  it("persists retry due time instead of relying on cron memory", async () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    let now = 1_000;
    let fail = true;
    const adapter: NotificationDeliveryAdapter = {
      deliver: async (_delivery: NotificationDelivery) =>
        fail
          ? {
              status: "failed",
              retryable: true,
              errorCode: "TRANSIENT",
            }
          : { status: "delivered" },
    };
    const service = new NotificationService({
      planner: new ServerNotificationPlanner(
        mealRules(["user-1"]),
      ),
      repository,
      targets: {
        listTargets: async () => [
          {
            userId: "user-1",
            deviceId: "phone-1",
            channel: "web-push",
            destinationId: "subscription-1",
            enabled: true,
          },
        ],
      },
      webPush: adapter,
      now: () => now,
    });
    service.record({
      kind: "meal-published",
      sourceEventId: "post-2",
      meal: "dinner",
      serviceDate: "2026-07-31",
      contentSha: "sha-2",
      preview: "카레",
      occurredAtEpochMs: 900,
    });

    await expect(service.runDue()).resolves.toMatchObject({
      retried: 1,
    });
    now = 5_999;
    fail = false;
    await expect(service.runDue()).resolves.toMatchObject({
      delivered: 0,
    });
    now = 6_000;
    await expect(service.runDue()).resolves.toMatchObject({
      delivered: 1,
    });
    database.close();
  });

  it("collects server-scheduled attendance reminders before outbox fanout", async () => {
    const now = Date.parse("2026-07-31T09:50:00+09:00");
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    const collectDue = vi.fn(async () => [
      {
        kind: "attendance-action-required" as const,
        sourceEventId:
          "attendance:2026-07-31:morning:before-10",
        userId: "user-1",
        attendanceDate: "2026-07-31",
        phase: "morning" as const,
        slot: "before-10" as const,
        minutesRemaining: 10 as const,
        status: "unverified" as const,
        reason: "desktop-offline" as const,
        occurredAtEpochMs: now,
      },
    ]);
    const webPush = {
      deliver: vi.fn().mockResolvedValue({ status: "delivered" }),
    } satisfies NotificationDeliveryAdapter;
    const service = new NotificationService({
      planner: new ServerNotificationPlanner({
        ...mealRules([]),
        isAttendancePhaseEnabled: () => true,
      }),
      repository,
      targets: targets(),
      webPush,
      attendanceLifecycle: { collectDue },
      now: () => now,
    });

    await expect(service.runDue()).resolves.toEqual({
      fannedOut: 2,
      delivered: 1,
      retried: 0,
      failed: 0,
    });
    expect(collectDue).toHaveBeenCalledWith(now);
    expect(
      repository.claimDesktopInbox(
        "user-1",
        "desktop-1",
        now,
        20,
        30_000,
      ),
    ).toMatchObject([
      {
        kind: "attendance-action-required",
        title: "오전 출석 직접 확인 필요 · 마감 10분 전",
      },
    ]);
    database.close();
  });

  it("uses one stable Web Push dedupe key across crash-recovered attempts", async () => {
    const deliver = vi
      .fn()
      .mockResolvedValue({ status: "delivered" });
    const adapter = new WebPushNotificationAdapter({
      deliver,
    } as unknown as PushDeliveryCoordinator, {
      now: () => 1_000,
    });
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    repository.enqueueIntent(
      new ServerNotificationPlanner(mealRules(["user-1"])).plan({
        kind: "meal-published",
        sourceEventId: "post-crash",
        meal: "lunch",
        serviceDate: "2026-07-31",
        contentSha: "sha-crash",
        preview: "김치찌개",
        occurredAtEpochMs: 900,
      })[0]!,
      1_000,
    );
    const [outbox] = repository.claimOutbox(1_000, 10, 100);
    repository.createDeliveries(
      outbox!.event,
      [
        {
          userId: "user-1",
          deviceId: "phone-1",
          channel: "web-push",
          destinationId: "push-1",
          enabled: true,
        },
      ],
      1_000,
    );
    repository.completeOutbox(outbox!.event.id, 1_000);
    const [first] = repository.claimWebPushDeliveries(
      1_000,
      10,
      100,
    );
    const [recovered] = repository.claimWebPushDeliveries(
      1_100,
      10,
      100,
    );

    await adapter.deliver(first!);
    await adapter.deliver(recovered!);
    expect(
      deliver.mock.calls.map(([input]) => input.dedupeKey),
    ).toEqual([
      `outbox:${first!.id}`,
      `outbox:${first!.id}`,
    ]);
    database.close();
  });

  it("limits Web Push provider concurrency while processing the whole leased batch", async () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    let active = 0;
    let maximumActive = 0;
    const leaseExpiries: number[] = [];
    const webPush: NotificationDeliveryAdapter = {
      async deliver(claimedDelivery) {
        leaseExpiries.push(claimedDelivery.leaseUntilEpochMs ?? -1);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { status: "delivered" };
      },
    };
    const service = new NotificationService({
      planner: new ServerNotificationPlanner(
        mealRules(["user-1"]),
      ),
      repository,
      targets: {
        listTargets: async () =>
          Array.from({ length: 25 }, (_, index) => ({
            userId: "user-1",
            deviceId: `phone-${index}`,
            channel: "web-push" as const,
            destinationId: `subscription-${index}`,
            enabled: true,
          })),
      },
      webPush,
      now: () => 1_000,
    });
    service.record({
      kind: "meal-published",
      sourceEventId: "post-concurrent",
      meal: "lunch",
      serviceDate: "2026-07-31",
      contentSha: "sha-concurrent",
      preview: "김치찌개",
      occurredAtEpochMs: 900,
    });

    await expect(service.runDue()).resolves.toEqual({
      fannedOut: 25,
      delivered: 25,
      retried: 0,
      failed: 0,
    });
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(10);
    expect(new Set(leaseExpiries)).toEqual(new Set([301_000]));
    database.close();
  });
});

describe("WebPushNotificationAdapter", () => {
  it("clamps provider TTL to the event's remaining lifetime", async () => {
    const deliver = vi
      .fn()
      .mockResolvedValue({ status: "delivered", statusCode: 201 });
    const adapter = new WebPushNotificationAdapter(
      { deliver } as unknown as PushDeliveryCoordinator,
      { now: () => 1_000 },
    );

    await expect(
      adapter.deliver(
        delivery({
          occurredAtEpochMs: 0,
          expiresAtEpochMs: 61_999,
        }),
      ),
    ).resolves.toEqual({ status: "delivered" });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ ttlSeconds: 60 }),
      }),
    );
  });

  it("rejects expired events without contacting the Push coordinator", async () => {
    const deliver = vi.fn();
    const adapter = new WebPushNotificationAdapter(
      { deliver } as unknown as PushDeliveryCoordinator,
      { now: () => 10_000 },
    );

    await expect(
      adapter.deliver(
        delivery({
          occurredAtEpochMs: 0,
          expiresAtEpochMs: 10_000,
        }),
      ),
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      errorCode: "EVENT_EXPIRED",
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});

function mealRules(users: readonly string[]): NotificationRuleReader {
  return {
    listMealSubscriberUserIds: () => [...users],
    isAttendancePhaseEnabled: () => false,
    listActiveWatches: () => [],
    findWaitingQueueHead: () => null,
  };
}

function targets(): NotificationTargetDirectory {
  return {
    listTargets: async () => [
      {
        userId: "user-1",
        deviceId: "phone-1",
        channel: "web-push",
        destinationId: "subscription-1",
        enabled: true,
      },
      {
        userId: "user-1",
        deviceId: "desktop-1",
        channel: "desktop",
        destinationId: "desktop-1",
        enabled: true,
      },
    ],
  };
}

function testDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(NOTIFICATION_SQL_SCHEMA);
  return database;
}

function delivery(input: {
  readonly occurredAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}): NotificationDelivery {
  return {
    id: "delivery-1",
    eventId: "event-1",
    userId: "user-1",
    deviceId: "phone-1",
    channel: "web-push",
    destinationId: "subscription-1",
    status: "leased",
    attempt: 1,
    availableAtEpochMs: 0,
    leaseUntilEpochMs: 300_000,
    event: {
      id: "event-1",
      createdAtEpochMs: 0,
      intent: {
        userId: "user-1",
        kind: "attendance-action-required",
        sourceEventId: "attendance-1",
        dedupeKey: "attendance-dedupe",
        content: {
          title: "출석 확인",
          body: "출석을 확인하세요.",
          path: "/app#attendance",
        },
        metadata: {},
        targetDeviceId: null,
        ...input,
      },
    },
  };
}
