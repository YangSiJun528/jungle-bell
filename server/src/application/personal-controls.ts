import { RenewalError } from "../domain/session";
import { randomOpaqueToken } from "../renewal/crypto";
import type {
  LaundryAppliance, LaundryQueueEntryRecord, LaundryWatchRecord, MealPreferenceRecord, RenewalStore,
} from "../workers/account-storage";

const ACTIVE_WATCH_LIMIT = 64;

export const DEFAULT_MEAL_PREFERENCE: MealPreferenceRecord = {
  enabled: false, breakfast: false, lunch: false, dinner: false, updatedAtEpochMs: 0,
};

export async function readMealPreference(store: RenewalStore, userId: string): Promise<MealPreferenceRecord> {
  return await store.getMealPreference(userId) ?? DEFAULT_MEAL_PREFERENCE;
}

export async function updateMealPreference(
  store: RenewalStore,
  userId: string,
  value: Omit<MealPreferenceRecord, "updatedAtEpochMs">,
  nowEpochMs: number,
): Promise<MealPreferenceRecord> {
  const preference = { ...value, updatedAtEpochMs: nowEpochMs };
  await store.setMealPreference(userId, preference);
  return preference;
}

export async function createLaundryWatch(input: {
  store: RenewalStore;
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
  store: RenewalStore;
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
