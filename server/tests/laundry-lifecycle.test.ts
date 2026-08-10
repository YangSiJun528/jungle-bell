import { describe, expect, it } from "vitest";
import {
  completedLaundryWatchIds, LAUNDRY_QUEUE_AVAILABILITY_TTL_MS, planLaundryTransition,
  type LaundryTransitionEvent,
} from "../src/domain/laundry-notifications";
import type { LaundryQueueEntryRecord, LaundryWatchRecord } from "../src/workers/account-storage";
import {
  isAvailableProjectedAppliance, LAUNDRY_QUEUE_CLAIM_TTL_MS, runLaundryLifecycle,
} from "../src/application/laundry-lifecycle";
import { MemoryRenewalStore } from "./helpers/memory-renewal-store";

function watch(id: string, userId: string, sessionId: string | null): LaundryWatchRecord {
  return {
    id, userId, machineId: "tower-3", appliance: "washer", sessionId,
    notifyBeforeMinutes: 10, notifyWhenAvailable: sessionId === null,
    status: "active", createdAtEpochMs: 1, updatedAtEpochMs: 1,
  };
}

function queue(id: string, userId: string): LaundryQueueEntryRecord {
  return {
    id, userId, machineId: null, appliance: "washer", status: "waiting",
    joinedAtEpochMs: 1, leftAtEpochMs: null, position: 1,
  };
}

function event(value: Partial<LaundryTransitionEvent> = {}): LaundryTransitionEvent {
  return {
    sourceEventId: "laundry-event-1", machineId: "tower-3", appliance: "washer",
    sessionId: "session-1", previousState: "BUSY", currentState: "BUSY",
    remainingMinutes: 5, occurredAtEpochMs: 2_000, ...value,
  };
}

describe("laundry notification domain", () => {
  it("deduplicates one availability event per user across watch and FIFO queue origins", () => {
    const planned = planLaundryTransition(
      event({ sessionId: null, currentState: "AVAILABLE", remainingMinutes: 0 }),
      [watch("watch-1", "user-1", null), watch("watch-2", "user-2", null)],
      queue("queue-1", "user-1"),
    );
    expect(planned).toHaveLength(2);
    expect(planned.map((item) => item.notification.userId).sort()).toEqual(["user-1", "user-2"]);
    expect(planned.every((item) => item.notification.kind === "laundry-available")).toBe(true);
    const queueAndWatch = planned.find((item) => item.notification.userId === "user-1");
    expect(queueAndWatch?.origins).toHaveLength(2);
    expect(queueAndWatch?.notification.expiresAtEpochMs)
      .toBe(2_000 + LAUNDRY_QUEUE_AVAILABILITY_TTL_MS);
    expect(JSON.parse(queueAndWatch!.notification.payloadJson)).toMatchObject({
      expiresAtEpochMs: 2_000 + LAUNDRY_QUEUE_AVAILABILITY_TTL_MS,
    });

    const watchOnly = planned.find((item) => item.notification.userId === "user-2");
    expect(watchOnly?.notification.expiresAtEpochMs).toBe(2_000 + 6 * 60 * 60_000);
  });

  it("uses session-less watches only for one-shot availability", () => {
    const available = watch("watch-available", "user-1", null);
    expect(planLaundryTransition(event({ currentState: "COMPLETED", remainingMinutes: 0 }), [available], null)).toEqual([]);
    expect(completedLaundryWatchIds(event({ currentState: "COMPLETED", remainingMinutes: 0 }), [available])).toEqual([]);
    expect(completedLaundryWatchIds(
      event({ sessionId: null, currentState: "AVAILABLE", remainingMinutes: 0 }), [available],
    )).toEqual([available.id]);
  });

  it("plans one stable threshold notification and terminal completion for a matching session", () => {
    const sessionWatch = watch("watch-session", "user-1", "session-1");
    const first = planLaundryTransition(event({ sourceEventId: "tick-1" }), [sessionWatch], null);
    const repeated = planLaundryTransition(event({ sourceEventId: "tick-2", remainingMinutes: 4 }), [sessionWatch], null);
    expect(first).toMatchObject([{ notification: { kind: "laundry-finishing" } }]);
    expect(first[0]?.notification.sourceEventId).toBe(repeated[0]?.notification.sourceEventId);

    const completed = event({ sourceEventId: "completed", currentState: "COMPLETED", remainingMinutes: 0 });
    expect(planLaundryTransition(completed, [sessionWatch], null)).toMatchObject([
      { notification: { kind: "laundry-completed" } },
    ]);
    expect(completedLaundryWatchIds(completed, [sessionWatch])).toEqual([sessionWatch.id]);
  });
});

describe("laundry lifecycle application", () => {
  const emptyStorage = {
    readState: async () => null,
    readJson: async () => null,
  };

  it("uses normalized operational/projection status instead of raw event text for availability", () => {
    expect(isAvailableProjectedAppliance({
      operationalStatus: "IDLE", projection: { status: "IDLE" },
    } as never)).toBe(true);
    expect(isAvailableProjectedAppliance({
      operationalStatus: "UNKNOWN", projection: { status: "IDLE" },
    } as never)).toBe(true);
    expect(isAvailableProjectedAppliance({
      operationalStatus: "SCHEDULED", projection: { status: "IDLE" },
    } as never)).toBe(false);
    expect(isAvailableProjectedAppliance({
      operationalStatus: "UNKNOWN", projection: { status: "UNKNOWN" },
    } as never)).toBe(false);
  });

  it("durably inserts a terminal notification and completes its watch exactly once", async () => {
    const store = new MemoryRenewalStore();
    const sessionWatch = watch("watch-session", "user-1", "session-1");
    store.laundryWatches.set(sessionWatch.id, sessionWatch);
    store.laundryEvents.set("completed-1", {
      id: "completed-1", machineId: "tower-3", appliance: "washer", sessionId: "session-1",
      type: "COMPLETED", previousObservedAt: "1970-01-01T00:00:01.000Z",
      observedAt: "1970-01-01T00:00:02.000Z", etaDeltaMinutes: null,
      previousState: "RUNNING", currentState: "END", detail: {},
    });
    await expect(runLaundryLifecycle(store, emptyStorage, 2_000)).resolves.toEqual({
      processedEvents: 1, notifications: 1, queueClaims: 0,
    });
    expect(store.laundryWatches.get(sessionWatch.id)?.status).toBe("completed");
    expect([...store.notifications.values()]).toHaveLength(1);
    await expect(runLaundryLifecycle(store, emptyStorage, 2_001)).resolves.toEqual({
      processedEvents: 0, notifications: 0, queueClaims: 0,
    });
  });

  it("never treats a raw POWER_OFF transition as proof that a queue target is available", async () => {
    const store = new MemoryRenewalStore();
    store.laundryQueue.set("queue-1", {
      id: "queue-1", userId: "user-1", machineId: null, appliance: "washer",
      status: "waiting", joinedAtEpochMs: 1, leftAtEpochMs: null, position: 1,
    });
    store.laundryEvents.set("raw-power-off", {
      id: "raw-power-off", machineId: "tower-3", appliance: "washer", sessionId: null,
      type: "STATE_CHANGED", previousObservedAt: "1970-01-01T00:00:01.000Z",
      observedAt: "1970-01-01T00:00:02.000Z", etaDeltaMinutes: null,
      previousState: "RUNNING", currentState: "POWER_OFF", detail: {},
    });

    await expect(runLaundryLifecycle(store, emptyStorage, 2_000)).resolves.toEqual({
      processedEvents: 1, notifications: 0, queueClaims: 0,
    });
    expect(store.laundryQueue.get("queue-1")?.status).toBe("waiting");
  });

  it.each([
    ["latest collection failed", 2_000, { lastError: "upstream timeout", consecutiveFailures: 1 }],
    ["latest projection is stale", 123_000, { lastError: null, consecutiveFailures: 0 }],
  ] as const)("does not create availability notifications or claims when %s", async (
    _case,
    nowEpochMs,
    stateOverride,
  ) => {
    const store = new MemoryRenewalStore();
    const availableWatch = watch("watch-available", "watch-user", null);
    store.laundryWatches.set(availableWatch.id, availableWatch);
    store.laundryQueue.set("queue-1", {
      id: "queue-1", userId: "queue-user", machineId: null, appliance: "washer",
      status: "waiting", joinedAtEpochMs: 1, leftAtEpochMs: null, position: 1,
    });
    const storage = {
      readState: async () => ({
        source: "laundry" as const, lastAttemptAt: "1970-01-01T00:00:01.000Z",
        lastSuccessAt: "1970-01-01T00:00:01.000Z", lastResponseSha: "a".repeat(64),
        lastRawKey: "raw", lastNormalizedKey: "laundry", versionFirstSeenAt: "1970-01-01T00:00:01.000Z",
        ...stateOverride,
      }),
      readJson: async <T>() => availableLaundryVersion() as T,
    };

    await expect(runLaundryLifecycle(store, storage, nowEpochMs)).resolves.toEqual({
      processedEvents: 0, notifications: 0, queueClaims: 0,
    });
    expect(store.laundryQueue.get("queue-1")?.status).toBe("waiting");
    expect(store.laundryWatches.get(availableWatch.id)?.status).toBe("active");
    expect([...store.notifications.values()]).toEqual([]);
  });

  it("loads all projected availability targets in one bulk call regardless of appliance count", async () => {
    const store = new MemoryRenewalStore();
    let bulkCalls = 0;
    let perApplianceCalls = 0;
    store.listLaundryAvailabilityTargets = async (input) => {
      bulkCalls += 1;
      expect(input.appliances).toHaveLength(13);
      return input.appliances.map((appliance) => ({ ...appliance, watches: [], queueEntry: null }));
    };
    store.listActiveLaundryWatches = async () => {
      perApplianceCalls += 1;
      return [];
    };
    store.findWaitingLaundryQueueHead = async () => {
      perApplianceCalls += 1;
      return null;
    };
    const version = availableLaundryVersion();
    version.machines = Array.from({ length: 13 }, (_, index) => ({
      id: `tower-${index + 1}`,
      washer: {
        ...version.machines[0]!.washer!,
        machineId: `tower-${index + 1}`,
      },
      dryer: null,
    }));
    const storage = {
      readState: async () => ({
        source: "laundry" as const, lastAttemptAt: "1970-01-01T00:00:01.000Z",
        lastSuccessAt: "1970-01-01T00:00:01.000Z", lastResponseSha: "a".repeat(64),
        lastRawKey: "raw", lastNormalizedKey: "laundry", versionFirstSeenAt: "1970-01-01T00:00:01.000Z",
        consecutiveFailures: 0, lastError: null,
      }),
      readJson: async <T>() => version as T,
    };

    await expect(runLaundryLifecycle(store, storage, 1_000)).resolves.toEqual({
      processedEvents: 0, notifications: 0, queueClaims: 0,
    });
    expect(bulkCalls).toBe(1);
    expect(perApplianceCalls).toBe(0);
  });

  it("claims only the FIFO queue head and advances after the best-effort claim TTL", async () => {
    const store = new MemoryRenewalStore();
    let lastSuccessAtEpochMs = 1_000;
    for (const [id, userId, joinedAtEpochMs] of [["queue-1", "user-1", 900], ["queue-2", "user-2", 901]] as const) {
      store.laundryQueue.set(id, {
        id, userId, machineId: null, appliance: "washer", status: "waiting",
        joinedAtEpochMs, leftAtEpochMs: null, position: 1,
      });
    }
    const storage = {
      readState: async () => ({
        source: "laundry" as const, lastAttemptAt: "1970-01-01T00:00:01.000Z",
        lastSuccessAt: new Date(lastSuccessAtEpochMs).toISOString(), lastResponseSha: "a".repeat(64),
        lastRawKey: "raw", lastNormalizedKey: "laundry", versionFirstSeenAt: "1970-01-01T00:00:01.000Z",
        consecutiveFailures: 0, lastError: null,
      }),
      readJson: async <T>() => availableLaundryVersion() as T,
    };
    await expect(runLaundryLifecycle(store, storage, 1_000)).resolves.toMatchObject({ queueClaims: 1, notifications: 1 });
    expect(store.laundryQueue.get("queue-1")?.status).toBe("claimed");
    expect(store.laundryQueue.get("queue-2")?.status).toBe("waiting");
    const beforeExpiry = 1_000 + LAUNDRY_QUEUE_CLAIM_TTL_MS - 1;
    lastSuccessAtEpochMs = beforeExpiry;
    await expect(runLaundryLifecycle(store, storage, beforeExpiry))
      .resolves.toMatchObject({ queueClaims: 0 });
    const atExpiry = 1_000 + LAUNDRY_QUEUE_CLAIM_TTL_MS;
    lastSuccessAtEpochMs = atExpiry;
    await expect(runLaundryLifecycle(store, storage, atExpiry))
      .resolves.toMatchObject({ queueClaims: 1, notifications: 1 });
    expect(store.laundryQueue.get("queue-1")?.status).toBe("expired");
    expect(store.laundryQueue.get("queue-2")?.status).toBe("claimed");
  });
});

function availableLaundryVersion() {
  return {
    schemaVersion: 1 as const,
    sourceVersionSha: "a".repeat(64),
    observedAt: "1970-01-01T00:00:01.000Z",
    machines: [{
      id: "tower-3",
      washer: {
        machineId: "tower-3", appliance: "washer" as const, observedAt: "1970-01-01T00:00:01.000Z",
        state: { code: "POWER_OFF", raw: "POWER_OFF", known: true }, operationalStatus: "IDLE" as const,
        remainingMinutes: 0, totalMinutes: 0, startedAt: "1970-01-01T00:00:00.000Z",
        estimatedFinishAt: null, remoteControlEnabled: false, cycleCount: 1, sessionId: null, errorCode: null,
      },
      dryer: null,
    }],
    events: [], unknownEnums: [],
  };
}
