import { describe, expect, it } from "vitest";

import {
  SqlitePushDedupeStore,
  SqlitePushSubscriptionStore,
  openSqliteDatabase,
} from "./index.js";
import type { SqliteDatabase } from "./index.js";

function record(id = "push-1") {
  return {
    id,
    userId: "user-1",
    deviceId: "device-1",
    subscription: {
      endpoint: `https://updates.push.services.mozilla.com/wpush/${id}`,
      expirationTime: null,
      keys: {
        auth: "a".repeat(22),
        p256dh: "b".repeat(87),
      },
    },
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
    revokedAtEpochMs: null,
    revokedReason: null,
  } as const;
}

function seedMobile(database: SqliteDatabase): void {
  database.exec(`
    INSERT INTO users VALUES ('user-1', 'active', 0);
    INSERT INTO external_identities VALUES (
      'jungle_lms', '${"1".repeat(64)}', 1, 'user-1', 0, 0
    );
    INSERT INTO desktop_devices VALUES (
      'user-1', 'desktop-1', 0, 0, 0, 'connected', NULL
    );
    INSERT INTO pairing_challenges VALUES (
      'pairing-1', 'user-1', 'desktop-1', 'pairing-hash-1',
      'manual-hash-1', 'approved', 'Phone',
      'jbmi_11111111111111111111111111111111', 0, 10, 1, 2
    );
    INSERT INTO device_sessions VALUES (
      'session-1', 'pairing-1', 'user-1', 'device-1', 'Phone',
      'jbmi_11111111111111111111111111111111',
      'token-hash-1', '["attendance:read"]',
      1, 10000, 1, NULL, 0
    );
  `);
}

describe("SQLite push stores", () => {
  it("persists and revokes browser subscriptions", async () => {
    const database = openSqliteDatabase(":memory:");
    seedMobile(database);
    const store = new SqlitePushSubscriptionStore(database);
    await expect(store.upsert(record())).resolves.toBe(true);

    await expect(store.findActiveById("push-1")).resolves.toEqual(record());
    await expect(
      store.revoke("push-1", {
        atEpochMs: 2_000,
        reason: "user-unsubscribed",
      }),
    ).resolves.toBe(true);
    await expect(store.findActiveById("push-1")).resolves.toBeUndefined();
    await expect(store.findById("push-1")).resolves.toMatchObject({
      revokedAtEpochMs: 2_000,
      revokedReason: "user-unsubscribed",
    });
    database.close();
  });

  it("prevents endpoint ownership transfer and multiple active endpoints per device", async () => {
    const database = openSqliteDatabase(":memory:");
    seedMobile(database);
    const store = new SqlitePushSubscriptionStore(database);
    await expect(store.upsert(record())).resolves.toBe(true);
    await expect(
      store.upsert({ ...record(), userId: "other-user" }),
    ).resolves.toBe(false);
    await expect(
      store.upsert(record("push-2")),
    ).resolves.toBe(false);

    await expect(store.findActiveById("push-1")).resolves.toMatchObject({
      userId: "user-1",
      deviceId: "device-1",
    });
    await expect(store.findById("push-2")).resolves.toBeUndefined();
    database.close();
  });

  it("claims a dedupe key once and permits retry only after release or expiry", async () => {
    const database = openSqliteDatabase(":memory:");
    const first = new SqlitePushDedupeStore(database, 1_000);
    const second = new SqlitePushDedupeStore(database, 1_000);

    await expect(
      Promise.all([
        first.tryStart("event:1", 1_000),
        second.tryStart("event:1", 1_000),
      ]),
    ).resolves.toEqual([true, false]);
    await first.release("event:1");
    await expect(second.tryStart("event:1", 1_001)).resolves.toBe(true);
    await second.complete("event:1", 1_001);
    await expect(first.tryStart("event:1", 1_500)).resolves.toBe(false);
    await expect(first.tryStart("event:1", 2_001)).resolves.toBe(true);
    database.close();
  });

  it("uses a short pending lease but retains completed delivery keys", async () => {
    const database = openSqliteDatabase(":memory:");
    const store = new SqlitePushDedupeStore(
      database,
      7 * 24 * 60 * 60 * 1_000,
      2 * 60 * 1_000,
    );

    await expect(store.tryStart("event:pending", 1_000)).resolves.toBe(true);
    await expect(
      store.tryStart("event:pending", 120_999),
    ).resolves.toBe(false);
    await expect(
      store.tryStart("event:pending", 121_000),
    ).resolves.toBe(true);
    await store.complete("event:pending", 121_000);
    await expect(
      store.tryStart("event:pending", 121_000 + 2 * 60 * 1_000),
    ).resolves.toBe(false);
    database.close();
  });
});
