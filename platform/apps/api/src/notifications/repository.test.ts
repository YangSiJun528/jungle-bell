import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type {
  NotificationIntent,
  StoredNotificationEvent,
} from "./contracts.js";
import {
  NOTIFICATION_SQL_SCHEMA,
  SqliteNotificationRepository,
} from "./repository.js";

describe("SqliteNotificationRepository", () => {
  it("inserts an idempotent user event and fans out durable deliveries", () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    const first = repository.enqueueIntent(intent(), 1_000);
    const duplicate = repository.enqueueIntent(intent(), 1_001);
    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({
      inserted: false,
      eventId: first.eventId,
    });

    const outbox = repository.claimOutbox(1_000, 10, 500);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.attempt).toBe(1);
    expect(
      repository.createDeliveries(
        outbox[0]!.event,
        [
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
        1_000,
      ),
    ).toBe(2);
    expect(repository.completeOutbox(first.eventId, 1_001)).toBe(true);

    const pushes = repository.claimWebPushDeliveries(1_000, 10, 500);
    expect(pushes).toMatchObject([
      {
        userId: "user-1",
        deviceId: "phone-1",
        attempt: 1,
        status: "leased",
      },
    ]);
    expect(repository.markDeliverySucceeded(pushes[0]!.id, 1_100)).toBe(
      true,
    );
    database.close();
  });

  it("leases desktop inbox items and requires an owned acknowledgement", () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    const event = enqueueAndClaim(repository);
    repository.createDeliveries(
      event,
      [
        {
          userId: "user-1",
          deviceId: "desktop-1",
          channel: "desktop",
          destinationId: "desktop-1",
          enabled: true,
        },
      ],
      1_000,
    );
    repository.completeOutbox(event.id, 1_000);

    const inbox = repository.claimDesktopInbox(
      "user-1",
      "desktop-1",
      1_000,
      20,
      500,
    );
    expect(inbox).toMatchObject([
      {
        eventId: event.id,
        kind: "meal-published",
        title: "오늘 중식",
        attempt: 1,
      },
    ]);
    expect(
      repository.acknowledgeDesktop(
        "user-2",
        "desktop-1",
        inbox[0]!.deliveryId,
        { outcome: "displayed", occurredAtEpochMs: 1_100 },
        1_200,
      ),
    ).toBe(false);
    expect(
      repository.acknowledgeDesktop(
        "user-1",
        "desktop-1",
        inbox[0]!.deliveryId,
        { outcome: "failed", occurredAtEpochMs: 1_100 },
        1_200,
      ),
    ).toBe(true);
    expect(
      repository.claimDesktopInbox(
        "user-1",
        "desktop-1",
        1_199,
        20,
        500,
      ),
    ).toEqual([]);
    expect(
      repository.claimDesktopInbox(
        "user-1",
        "desktop-1",
        1_200,
        20,
        500,
      ),
    ).toMatchObject([{ attempt: 2 }]);
    database.close();
  });

  it("reclaims expired outbox leases from durable due state", () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    repository.enqueueIntent(intent(), 1_000);
    expect(repository.claimOutbox(1_000, 10, 100)).toMatchObject([
      { attempt: 1 },
    ]);
    expect(repository.claimOutbox(1_099, 10, 100)).toEqual([]);
    expect(repository.claimOutbox(1_100, 10, 100)).toMatchObject([
      { attempt: 2 },
    ]);
    database.close();
  });

  it("completes expired outbox work and cancels stale deliveries after downtime", () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    const stale = {
      ...intent(),
      expiresAtEpochMs: 1_100,
    };
    repository.enqueueIntent(stale, 1_000);

    expect(repository.claimOutbox(1_100, 10, 100)).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT status, last_error_code FROM notification_outbox",
        )
        .get(),
    ).toEqual({
      status: "completed",
      last_error_code: "EVENT_EXPIRED",
    });

    const fresh = {
      ...intent(),
      dedupeKey: "jbn_meal_2",
      expiresAtEpochMs: 1_200,
    };
    repository.enqueueIntent(fresh, 1_000);
    const [claimed] = repository.claimOutbox(1_000, 10, 100);
    repository.createDeliveries(
      claimed!.event,
      [
        {
          userId: "user-1",
          deviceId: "phone-1",
          channel: "web-push",
          destinationId: "push-1",
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
      1_000,
    );
    repository.completeOutbox(claimed!.event.id, 1_000);

    expect(repository.claimWebPushDeliveries(1_200, 10, 100)).toEqual(
      [],
    );
    expect(
      repository.claimDesktopInbox(
        "user-1",
        "desktop-1",
        1_200,
        10,
        100,
      ),
    ).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT status, last_error_code FROM notification_deliveries ORDER BY channel",
        )
        .all(),
    ).toEqual([
      { status: "cancelled", last_error_code: "EVENT_EXPIRED" },
      { status: "cancelled", last_error_code: "EVENT_EXPIRED" },
    ]);
    database.close();
  });

  it("reclaims an uncommitted delivery lease with the same durable delivery id", () => {
    const database = testDatabase();
    const repository = new SqliteNotificationRepository(database);
    const event = enqueueAndClaim(repository);
    repository.createDeliveries(
      event,
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
    repository.completeOutbox(event.id, 1_000);
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
    expect(recovered).toMatchObject({
      id: first!.id,
      attempt: 2,
    });
    database.close();
  });
});

function enqueueAndClaim(
  repository: SqliteNotificationRepository,
): StoredNotificationEvent {
  repository.enqueueIntent(intent(), 1_000);
  const claimed = repository.claimOutbox(1_000, 10, 500);
  if (!claimed[0]) throw new Error("expected event");
  return claimed[0].event;
}

function intent(): NotificationIntent {
  return {
    userId: "user-1",
    kind: "meal-published",
    sourceEventId: "meal-source-1",
    dedupeKey: "jbn_meal_1",
    content: {
      title: "오늘 중식",
      body: "메뉴를 확인하세요",
      path: "/app#meals",
    },
    metadata: { meal: "lunch" },
    targetDeviceId: null,
    occurredAtEpochMs: 900,
    expiresAtEpochMs: 10_000,
  };
}

function testDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(NOTIFICATION_SQL_SCHEMA);
  return database;
}
