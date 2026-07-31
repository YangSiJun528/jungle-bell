import type {
  NotificationPreferences,
  NotificationPreferenceStore,
} from "../../domain/notification-preferences.js";
import {
  expectRow,
  parseStringArray,
  readBoolean,
  readInteger,
  readText,
  serializeStringArray,
} from "./codec.js";
import type { SqliteDatabase } from "./database.js";

const PREFERENCE_COLUMNS = `
  user_id,
  device_id,
  meal_breakfast,
  meal_lunch,
  meal_dinner,
  laundry_notify_when_available,
  selected_machine_ids_json,
  updated_at_epoch_ms
`;

const PREFERENCE_KEYS = [
  "user_id",
  "device_id",
  "meal_breakfast",
  "meal_lunch",
  "meal_dinner",
  "laundry_notify_when_available",
  "selected_machine_ids_json",
  "updated_at_epoch_ms",
] as const;

export class SqliteNotificationPreferenceStore
  implements NotificationPreferenceStore
{
  constructor(private readonly database: SqliteDatabase) {}

  async get(
    userId: string,
    deviceId: string,
  ): Promise<NotificationPreferences | null> {
    const row = this.database
      .prepare(
        `SELECT ${PREFERENCE_COLUMNS} FROM notification_preferences WHERE user_id = ? AND device_id = ?`,
      )
      .get(userId, deviceId);
    return row === undefined ? null : mapPreferences(row);
  }

  async upsert(preferences: NotificationPreferences): Promise<void> {
    const selectedMachineIdsJson = serializeStringArray(
      preferences.laundry.selectedMachineIds,
      "selectedMachineIds",
    );
    this.database
      .prepare(`
        INSERT INTO notification_preferences (
          ${PREFERENCE_COLUMNS}
        ) VALUES (
          @userId,
          @deviceId,
          @mealBreakfast,
          @mealLunch,
          @mealDinner,
          @laundryNotifyWhenAvailable,
          @selectedMachineIdsJson,
          @updatedAtEpochMs
        )
        ON CONFLICT (user_id, device_id) DO UPDATE SET
          meal_breakfast = excluded.meal_breakfast,
          meal_lunch = excluded.meal_lunch,
          meal_dinner = excluded.meal_dinner,
          laundry_notify_when_available = excluded.laundry_notify_when_available,
          selected_machine_ids_json = excluded.selected_machine_ids_json,
          updated_at_epoch_ms = excluded.updated_at_epoch_ms
      `)
      .run({
        userId: preferences.userId,
        deviceId: preferences.deviceId,
        mealBreakfast: Number(preferences.meals.breakfast),
        mealLunch: Number(preferences.meals.lunch),
        mealDinner: Number(preferences.meals.dinner),
        laundryNotifyWhenAvailable: Number(
          preferences.laundry.notifyWhenAvailable,
        ),
        selectedMachineIdsJson,
        updatedAtEpochMs: preferences.updatedAtEpochMs,
      });
  }
}

function mapPreferences(value: unknown): NotificationPreferences {
  const row = expectRow(
    value,
    PREFERENCE_KEYS,
    "notification preferences",
  );
  return {
    userId: readText(row, "user_id"),
    deviceId: readText(row, "device_id"),
    meals: {
      breakfast: readBoolean(row, "meal_breakfast"),
      lunch: readBoolean(row, "meal_lunch"),
      dinner: readBoolean(row, "meal_dinner"),
    },
    laundry: {
      notifyWhenAvailable: readBoolean(
        row,
        "laundry_notify_when_available",
      ),
      selectedMachineIds: parseStringArray(
        readText(row, "selected_machine_ids_json"),
        "selected_machine_ids_json",
      ),
    },
    updatedAtEpochMs: readInteger(row, "updated_at_epoch_ms"),
  };
}
