import type { LaundryEvent } from "@jungle-bell/backend-common/collection/types";
import type { LaundryVersion } from "@jungle-bell/backend-common/collection/laundry";
import { projectLaundry, type ProjectedAppliance } from "@jungle-bell/backend-common/collection/projection";
import {
  completedLaundryWatchIds, planLaundryTransition,
  type LaundryLifecycleState, type LaundryTransitionEvent, type PlannedLaundryNotification,
} from "@jungle-bell/backend-common/domain/laundry-notifications";
import type {
  LaundryAppliance,
  LaundryAvailabilityTargetRecord,
  LaundryWatchRecord,
} from "@jungle-bell/backend-common/ports/account-storage";
import type { CollectorStorage } from "@jungle-bell/backend-common/ports/collector-storage";
import { randomOpaqueToken } from "@jungle-bell/backend-common/renewal/crypto";

type LaundryStorage = Pick<CollectorStorage, "readJson" | "readState">;

export interface LaundryLifecycleStore {
  listPendingLaundryEvents(limit: number): Promise<LaundryEvent[]>;
  listActiveLaundryWatches(input: {
    machineId: string;
    appliance: LaundryAppliance;
    sessionId: string | null;
  }): Promise<LaundryWatchRecord[]>;
  listLaundryAvailabilityTargets(input: {
    appliances: ReadonlyArray<{
      machineId: string;
      appliance: LaundryAppliance;
      sessionId: string | null;
    }>;
  }): Promise<LaundryAvailabilityTargetRecord[]>;
  applyLaundryLifecycleEvent(input: {
    eventId: string;
    processingToken: string;
    notifications: PlannedLaundryNotification[];
    completedWatchIds: string[];
    nowEpochMs: number;
  }): Promise<boolean>;
}

/** Applies collected laundry transitions and availability claims. */
export async function runLaundryLifecycle(
  store: LaundryLifecycleStore,
  storage: LaundryStorage,
  nowEpochMs: number,
): Promise<{ processedEvents: number; notifications: number }> {
  let processedEvents = 0;
  let notifications = 0;
  for (const source of await store.listPendingLaundryEvents(100)) {
    const event = transitionEvent(source, nowEpochMs);
    const watches = await store.listActiveLaundryWatches({
      machineId: event.machineId, appliance: event.appliance, sessionId: event.sessionId,
    });
    // Collector events may contain vendor-specific raw state labels. They can drive
    // session completion/attention/countdown rules, but never prove current availability.
    const planned = planLaundryTransition(event, watches);
    if (await store.applyLaundryLifecycleEvent({
      eventId: source.id, processingToken: randomOpaqueToken("jblp_"), notifications: planned,
      completedWatchIds: completedLaundryWatchIds(event, watches), nowEpochMs,
    })) {
      processedEvents += 1;
      notifications += planned.length;
    }
  }

  const state = await storage.readState("laundry");
  if (!state?.lastNormalizedKey) return { processedEvents, notifications };
  const version = await storage.readJson<LaundryVersion>(state.lastNormalizedKey);
  if (!version) return { processedEvents, notifications };
  const projected = projectLaundry(version, state, new Date(nowEpochMs), false);
  if (projected.quality.collection !== "SUCCESS") {
    return { processedEvents, notifications };
  }
  const available = projected.machines.flatMap((machine) => [machine.washer, machine.dryer])
    .filter((appliance): appliance is NonNullable<typeof appliance> =>
      appliance !== null && isAvailableProjectedAppliance(appliance))
    .sort((left, right) => left.machineId.localeCompare(right.machineId) || left.appliance.localeCompare(right.appliance));
  const availabilityTargets = await store.listLaundryAvailabilityTargets({
    appliances: available.map((appliance) => ({
      machineId: appliance.machineId, appliance: appliance.appliance, sessionId: appliance.sessionId,
    })),
  });
  const targetByAppliance = new Map(availabilityTargets.map((target) => [
    `${target.machineId}:${target.appliance}`,
    target,
  ]));
  for (const appliance of available) {
    const target = targetByAppliance.get(`${appliance.machineId}:${appliance.appliance}`);
    const watches = target?.watches ?? [];
    if (watches.length === 0) continue;
    const targetKey = watches.map((watch) => watch.id).sort().join(":");
    const event: LaundryTransitionEvent = {
      sourceEventId: `laundry-projection:${projected.sourceVersionSha}:${appliance.machineId}:${appliance.appliance}:${targetKey}`,
      machineId: appliance.machineId, appliance: appliance.appliance, sessionId: appliance.sessionId,
      previousState: "UNKNOWN", currentState: "AVAILABLE", remainingMinutes: 0, occurredAtEpochMs: nowEpochMs,
    };
    const planned = planLaundryTransition(event, watches);
    if (await store.applyLaundryLifecycleEvent({
      eventId: event.sourceEventId,
      processingToken: randomOpaqueToken("jblp_"),
      notifications: planned,
      completedWatchIds: completedLaundryWatchIds(event, watches),
      nowEpochMs,
    })) {
      notifications += planned.length;
    }
  }
  return { processedEvents, notifications };
}

export function isAvailableProjectedAppliance(
  appliance: Pick<ProjectedAppliance, "operationalStatus" | "projection">,
): boolean {
  return appliance.operationalStatus === "IDLE"
    || (appliance.operationalStatus === "UNKNOWN" && appliance.projection.status === "IDLE");
}

export function transitionEvent(source: LaundryEvent, fallbackNowEpochMs: number): LaundryTransitionEvent {
  const occurredAt = Date.parse(source.observedAt);
  return {
    sourceEventId: source.id, machineId: source.machineId, appliance: source.appliance,
    sessionId: source.sessionId, previousState: source.previousState === null ? null : lifecycleState(source.previousState),
    currentState: eventState(source), remainingMinutes: remainingMinutes(source),
    occurredAtEpochMs: Number.isSafeInteger(occurredAt) ? occurredAt : fallbackNowEpochMs,
  };
}

function eventState(event: LaundryEvent): LaundryLifecycleState {
  if (event.type === "COMPLETED") return "COMPLETED";
  if (event.type === "ERROR_ENTERED") return "ERROR";
  if (event.type === "PAUSED") return "PAUSED";
  if (event.type === "STOPPED_UNEXPECTEDLY") return "UNKNOWN";
  if (event.type === "UNKNOWN_STATE") return "UNKNOWN";
  return lifecycleState(event.currentState);
}

function lifecycleState(raw: string): LaundryLifecycleState {
  const state = raw.trim().toUpperCase();
  if (["POWER_OFF", "INITIAL", "IDLE"].includes(state)) return "UNKNOWN";
  if (state === "END" || state === "COMPLETED") return "COMPLETED";
  if (state === "ERROR") return "ERROR";
  if (["PAUSE", "PAUSED"].includes(state)) return "PAUSED";
  if (["UNKNOWN", ""].includes(state)) return "UNKNOWN";
  return "BUSY";
}

function remainingMinutes(event: LaundryEvent): number | null {
  const value = event.detail.currentRemainingMinutes;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
