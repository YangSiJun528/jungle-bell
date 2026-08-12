import { describe, expect, it } from "vitest";
import { D1NotificationRepository } from "../persistence/d1-notification-repository";
import type { NotificationRecord } from "../ports/account-storage";
import type { SqlDatabase, SqlPreparedStatement } from "../ports/sql-database";

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

function database(inserted: boolean): SqlDatabase {
  const statement = {
    bind: () => statement,
    first: async () => inserted ? { id: notification.id } : null,
  } as unknown as SqlPreparedStatement;
  return { prepare: () => statement } as unknown as SqlDatabase;
}

describe("D1NotificationRepository", () => {
  it("uses INSERT RETURNING instead of unreliable D1 trigger change counts", async () => {
    await expect(new D1NotificationRepository(database(true)).insert(notification)).resolves.toBe(true);
    await expect(new D1NotificationRepository(database(false)).insert(notification)).resolves.toBe(false);
  });
});
