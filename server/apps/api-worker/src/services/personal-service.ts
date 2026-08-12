import { RenewalError } from "../domain/session";
import { randomOpaqueToken } from "@jungle-bell/backend-common/renewal/crypto";
import type {
  LaundryAppliance, LaundryQueueEntryRecord, LaundryWatchRecord, MealPreferenceRecord, RenewalStore,
} from "@jungle-bell/backend-common/ports/account-storage";
import type {
  AttendancePreferences,
  AttendancePreferencesV2,
  LaundryQueueInput,
  LaundryWatchInput,
  MealPreferencesInput,
} from "@jungle-bell/backend-common/contracts/personal";

const ACTIVE_WATCH_LIMIT = 64;

export type PersonalControlsStore = Pick<RenewalStore,
  | "cancelLaundryQueueEntry"
  | "cancelLaundryWatch"
  | "createLaundryWatch"
  | "enqueueLaundry"
  | "getAttendancePreference"
  | "getMealPreference"
  | "listLaundryQueue"
  | "listLaundryWatches"
  | "setAttendancePreference"
  | "setLegacyAttendancePreference"
  | "setMealPreference"
>;

export const DEFAULT_MEAL_PREFERENCE: MealPreferenceRecord = {
  enabled: false, breakfast: false, lunch: false, dinner: false, updatedAtEpochMs: 0,
};

export async function readMealPreference(store: PersonalControlsStore, userId: string): Promise<MealPreferenceRecord> {
  return await store.getMealPreference(userId) ?? DEFAULT_MEAL_PREFERENCE;
}

export async function updateMealPreference(
  store: PersonalControlsStore,
  userId: string,
  value: Omit<MealPreferenceRecord, "updatedAtEpochMs">,
  nowEpochMs: number,
): Promise<MealPreferenceRecord> {
  const preference = { ...value, updatedAtEpochMs: nowEpochMs };
  await store.setMealPreference(userId, preference);
  return preference;
}

export async function createLaundryWatch(input: {
  store: PersonalControlsStore;
  userId: string;
  value: Pick<LaundryWatchRecord, "machineId" | "appliance" | "sessionId" | "notifyBeforeMinutes" | "notifyWhenAvailable">;
  nowEpochMs: number;
}): Promise<LaundryWatchRecord> {
  const watch: LaundryWatchRecord = {
    id: randomOpaqueToken("jbw_"), userId: input.userId, ...input.value, status: "active",
    createdAtEpochMs: input.nowEpochMs, updatedAtEpochMs: input.nowEpochMs,
  };
  const result = await input.store.createLaundryWatch(watch, ACTIVE_WATCH_LIMIT);
  if (result === "duplicate") throw new RenewalError("LAUNDRY_WATCH_ALREADY_EXISTS", 409);
  if (result === "limit") throw new RenewalError("LAUNDRY_WATCH_LIMIT_REACHED", 409);
  return watch;
}

export async function joinLaundryQueue(input: {
  store: PersonalControlsStore;
  userId: string;
  value: { machineId: string | null; appliance: LaundryAppliance };
  nowEpochMs: number;
}): Promise<LaundryQueueEntryRecord> {
  const entry = await input.store.enqueueLaundry({
    id: randomOpaqueToken("jbq_"), userId: input.userId, ...input.value, status: "waiting",
    joinedAtEpochMs: input.nowEpochMs, leftAtEpochMs: null,
  });
  if (!entry) throw new RenewalError("LAUNDRY_QUEUE_ALREADY_JOINED", 409);
  return entry;
}

export function publicLaundryWatch(watch: LaundryWatchRecord) {
  return {
    id: watch.id, machineId: watch.machineId, appliance: watch.appliance, sessionId: watch.sessionId,
    notifyBeforeMinutes: watch.notifyBeforeMinutes, notifyWhenAvailable: watch.notifyWhenAvailable,
    status: watch.status, createdAtEpochMs: watch.createdAtEpochMs, updatedAtEpochMs: watch.updatedAtEpochMs,
  };
}

export function publicLaundryQueueEntry(entry: LaundryQueueEntryRecord) {
  return {
    id: entry.id, machineId: entry.machineId, appliance: entry.appliance, status: entry.status,
    joinedAtEpochMs: entry.joinedAtEpochMs, leftAtEpochMs: entry.leftAtEpochMs,
    position: entry.status === "waiting" ? entry.position : null,
  };
}

const DEFAULT_ATTENDANCE_PREFERENCE: AttendancePreferencesV2 = {
  enabled: true,
  morning: true,
  evening: true,
  morningStartHour: 9,
  eveningEndHour: 4,
  morningIntervalMinutes: 15,
  eveningIntervalMinutes: 15,
  skipSunday: false,
  skipAttendanceDate: null,
};

/** Personal settings and laundry workflows shared by desktop/mobile controllers. */
export class PersonalService {
  constructor(private readonly store: PersonalControlsStore) {}

  async readAttendancePreferences(userId: string): Promise<AttendancePreferencesV2> {
    return await this.store.getAttendancePreference(userId) ?? DEFAULT_ATTENDANCE_PREFERENCE;
  }

  async readLegacyAttendancePreferences(userId: string): Promise<AttendancePreferences> {
    return legacyAttendancePreferences(await this.readAttendancePreferences(userId));
  }

  async updateAttendancePreferences(
    userId: string,
    preference: AttendancePreferencesV2,
    nowEpochMs: number,
  ): Promise<AttendancePreferencesV2> {
    await this.store.setAttendancePreference(userId, preference, nowEpochMs);
    return preference;
  }

  async updateLegacyAttendancePreferences(
    userId: string,
    preference: AttendancePreferences,
    nowEpochMs: number,
  ): Promise<AttendancePreferences> {
    await this.store.setLegacyAttendancePreference(userId, preference, nowEpochMs);
    return preference;
  }

  readMealPreferences(userId: string) {
    return readMealPreference(this.store, userId);
  }

  updateMealPreferences(userId: string, preference: MealPreferencesInput, nowEpochMs: number) {
    return updateMealPreference(this.store, userId, preference, nowEpochMs);
  }

  async listLaundryWatches(userId: string) {
    return (await this.store.listLaundryWatches(userId)).map(publicLaundryWatch);
  }

  async createLaundryWatch(userId: string, value: LaundryWatchInput, nowEpochMs: number) {
    return publicLaundryWatch(await createLaundryWatch({ store: this.store, userId, value, nowEpochMs }));
  }

  cancelLaundryWatch(userId: string, watchId: string, nowEpochMs: number) {
    return this.store.cancelLaundryWatch(userId, watchId, nowEpochMs);
  }

  async listLaundryQueue(userId: string, nowEpochMs: number) {
    return (await this.store.listLaundryQueue(userId, nowEpochMs)).map(publicLaundryQueueEntry);
  }

  async joinLaundryQueue(userId: string, value: LaundryQueueInput, nowEpochMs: number) {
    return publicLaundryQueueEntry(await joinLaundryQueue({ store: this.store, userId, value, nowEpochMs }));
  }

  leaveLaundryQueue(userId: string, entryId: string, nowEpochMs: number) {
    return this.store.cancelLaundryQueueEntry(userId, entryId, nowEpochMs);
  }
}

function legacyAttendancePreferences(preference: AttendancePreferencesV2): AttendancePreferences {
  return {
    morning: preference.morning,
    evening: preference.evening,
    skipSunday: preference.skipSunday,
    skipAttendanceDate: preference.skipAttendanceDate,
  };
}
