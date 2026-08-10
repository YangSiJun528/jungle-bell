import type { LaundryEvent } from "../collector/types";
import type { LaundryVersion } from "../collector/laundry";
import { projectLaundry, type ProjectedAppliance } from "../collector/projection";
import {
  completedLaundryWatchIds, LAUNDRY_QUEUE_AVAILABILITY_TTL_MS, planLaundryTransition,
  type LaundryLifecycleState, type LaundryTransitionEvent,
} from "../domain/laundry-notifications";
import { randomOpaqueToken } from "../renewal/crypto";
import type { RenewalStore } from "../workers/account-storage";
import type { CloudflareApiStorage } from "../workers/cloudflare-storage";

export const LAUNDRY_QUEUE_CLAIM_TTL_MS = LAUNDRY_QUEUE_AVAILABILITY_TTL_MS;

type LaundryStorage = Pick<CloudflareApiStorage, "readJson" | "readState">;

export async function runLaundryLifecycle(
  store: RenewalStore,
  storage: LaundryStorage,
  nowEpochMs: number,
): Promise<{ processedEvents: number; notifications: number; queueClaims: number }> {
  await store.expireLaundryQueueClaims(nowEpochMs);
  let processedEvents = 0;
  let notifications = 0;
  let queueClaims = 0;
  for (const source of await store.listPendingLaundryEvents(100)) {
    const event = transitionEvent(source, nowEpochMs);
    const watches = await store.listActiveLaundryWatches({
      machineId: event.machineId, appliance: event.appliance, sessionId: event.sessionId,
    });
    // Collector events may contain vendor-specific raw state labels. They can drive
    // session completion/attention/countdown rules, but never availability claims.
    const planned = planLaundryTransition(event, watches, null);
    if (await store.applyLaundryLifecycleEvent({
      eventId: source.id, processingToken: randomOpaqueToken("jblp_"), notifications: planned,
      completedWatchIds: completedLaundryWatchIds(event, watches), queueClaim: null, nowEpochMs,
    })) {
      processedEvents += 1;
      notifications += planned.length;
    }
  }

  const state = await storage.readState("laundry");
  if (!state?.lastNormalizedKey) return { processedEvents, notifications, queueClaims };
  const version = await storage.readJson<LaundryVersion>(state.lastNormalizedKey);
  if (!version) return { processedEvents, notifications, queueClaims };
  const projected = projectLaundry(version, state, new Date(nowEpochMs), false);
  if (projected.quality.collection !== "SUCCESS") {
    return { processedEvents, notifications, queueClaims };
  }
  const available = projected.machines.flatMap((machine) => [machine.washer, machine.dryer])
    .filter((appliance): appliance is NonNullable<typeof appliance> =>
      appliance !== null && isAvailableProjectedAppliance(appliance))
    .sort((left, right) => left.machineId.localeCompare(right.machineId) || left.appliance.localeCompare(right.appliance));
  const availabilityTargets = await store.listLaundryAvailabilityTargets({
    appliances: available.map((appliance) => ({
      machineId: appliance.machineId, appliance: appliance.appliance, sessionId: appliance.sessionId,
    })),
    nowEpochMs,
  });
  const targetByAppliance = new Map(availabilityTargets.map((target) => [
    `${target.machineId}:${target.appliance}`,
    target,
  ]));
  for (const appliance of available) {
    const target = targetByAppliance.get(`${appliance.machineId}:${appliance.appliance}`);
    const watches = target?.watches ?? [];
    const entry = target?.queueEntry ?? null;
    if (!entry && watches.length === 0) continue;
    const targetKey = [
      entry?.id ?? "no-queue",
      ...watches.map((watch) => watch.id).sort(),
    ].join(":");
    const event: LaundryTransitionEvent = {
      sourceEventId: `laundry-projection:${projected.sourceVersionSha}:${appliance.machineId}:${appliance.appliance}:${targetKey}`,
      machineId: appliance.machineId, appliance: appliance.appliance, sessionId: appliance.sessionId,
      previousState: "UNKNOWN", currentState: "AVAILABLE", remainingMinutes: 0, occurredAtEpochMs: nowEpochMs,
    };
    const planned = planLaundryTransition(event, watches, entry);
    const queueClaim = entry ? {
      entryId: entry.id, userId: entry.userId, machineId: appliance.machineId,
      appliance: appliance.appliance, claimToken: randomOpaqueToken("jblc_"),
      expiresAtEpochMs: nowEpochMs + LAUNDRY_QUEUE_CLAIM_TTL_MS,
    } : null;
    if (await store.applyLaundryLifecycleEvent({
      eventId: event.sourceEventId,
      processingToken: randomOpaqueToken("jblp_"),
      notifications: planned,
      completedWatchIds: completedLaundryWatchIds(event, watches),
      queueClaim,
      nowEpochMs,
    })) {
      notifications += planned.length;
      if (queueClaim) queueClaims += 1;
    }
  }
  return { processedEvents, notifications, queueClaims };
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
