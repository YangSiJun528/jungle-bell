import { describe, expect, it } from "vitest";
import { D1NotificationRepository } from "../src/repositories/d1-notification-repository";
import type { NotificationRecord } from "../src/workers/account-storage";

const notification: NotificationRecord = {
  id: "notification-1",
  userId: "user-1",
  sourceEventId: "event-1",
  kind: "test",
  title: "Test",
  body: "Body",
  path: "/dashboard.html#notifications",
  payloadJson: "{}",
  createdAtEpochMs: 1,
  dueAtEpochMs: 1,
  expiresAtEpochMs: 2,
  desktopAttempt: 0,
};

function database(inserted: boolean): D1Database {
  const statement = {
    bind: () => statement,
    first: async () => inserted ? { id: notification.id } : null,
  } as unknown as D1PreparedStatement;
  return { prepare: () => statement } as unknown as D1Database;
}

describe("D1NotificationRepository", () => {
  it("uses INSERT RETURNING instead of unreliable D1 trigger change counts", async () => {
    await expect(new D1NotificationRepository(database(true)).insert(notification)).resolves.toBe(true);
    await expect(new D1NotificationRepository(database(false)).insert(notification)).resolves.toBe(false);
  });
});
