import type {
  LaundryAppliance,
  LaundryQueueEntry,
  LaundryResponse,
  LaundryWatch,
} from "../campus/contracts.js";
import {
  SqliteCampusRepository,
  SqliteCampusUserRepository,
} from "../campus/repository.js";
import type { SqliteDatabase } from "../infra/sqlite/database.js";
import type {
  NotificationSourceEvent,
} from "./contracts.js";
import { ServerNotificationPlanner } from "./planner.js";
import type { NotificationRepository } from "./repository.js";

export const LAUNDRY_QUEUE_CLAIM_TTL_MS = 5 * 60 * 1_000;

type LaundryTransitionEvent = Extract<
  NotificationSourceEvent,
  { readonly kind: "laundry-transition" }
>;

export interface LaundryLifecycleResult {
  readonly planned: number;
  readonly inserted: number;
}

export interface LaundryNotificationLifecycle {
  record(event: LaundryTransitionEvent): LaundryLifecycleResult;
  runDue(nowEpochMs: number): LaundryLifecycleResult;
}

/**
 * Owns the SQLite transaction that couples one-shot laundry rule state with
 * durable notification event/outbox creation.
 */
export class SqliteLaundryNotificationLifecycle
  implements LaundryNotificationLifecycle
{
  private readonly queueClaimTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly dependencies: {
      readonly database: SqliteDatabase;
      readonly campus: Pick<
        SqliteCampusRepository,
        "getStoredSnapshot"
      >;
      readonly rules: SqliteCampusUserRepository;
      readonly planner: ServerNotificationPlanner;
      readonly notifications: NotificationRepository;
      readonly now?: () => number;
      readonly queueClaimTtlMs?: number;
    },
  ) {
    this.queueClaimTtlMs =
      dependencies.queueClaimTtlMs ?? LAUNDRY_QUEUE_CLAIM_TTL_MS;
    if (
      !Number.isSafeInteger(this.queueClaimTtlMs) ||
      this.queueClaimTtlMs < 30_000 ||
      this.queueClaimTtlMs > 30 * 60 * 1_000
    ) {
      throw new TypeError("Laundry queue claim TTL is invalid.");
    }
    this.now = dependencies.now ?? Date.now;
  }

  record(event: LaundryTransitionEvent): LaundryLifecycleResult {
    const run = this.dependencies.database.transaction(() => {
      const nowEpochMs = this.now();
      this.dependencies.rules.expireQueueClaims(nowEpochMs);
      const watches = this.dependencies.rules.listActiveWatches({
        machineId: event.machineId,
        appliance: event.appliance,
        sessionId: event.sessionId,
      });
      const queueEntry = becameAvailable(event)
        ? this.dependencies.rules.claimWaitingQueueHead({
            machineId: event.machineId,
            appliance: event.appliance,
            claimedAtEpochMs: nowEpochMs,
            expiresAtEpochMs:
              nowEpochMs + this.queueClaimTtlMs,
          })
        : null;
      const intents =
        this.dependencies.planner.planLaundryTransition(event, {
          watches,
          queueEntry,
        });
      const inserted = enqueue(
        this.dependencies.notifications,
        intents,
        nowEpochMs,
      );
      const completedWatchIds = watches
        .filter((watch) => isTerminalForWatch(event, watch))
        .map((watch) => watch.id);
      this.dependencies.rules.completeActiveWatches(
        completedWatchIds,
        nowEpochMs,
      );
      return { planned: intents.length, inserted };
    });
    return run.immediate();
  }

  runDue(nowEpochMs: number): LaundryLifecycleResult {
    assertEpoch(nowEpochMs);
    const run = this.dependencies.database.transaction(() => {
      this.dependencies.rules.expireQueueClaims(nowEpochMs);
      const snapshot =
        this.dependencies.campus.getStoredSnapshot("laundry");
      if (snapshot === null) {
        return { planned: 0, inserted: 0 };
      }
      let planned = 0;
      let inserted = 0;
      for (const appliance of availableAppliances(snapshot.data)) {
        const queueEntry =
          this.dependencies.rules.claimWaitingQueueHead({
            machineId: appliance.machineId,
            appliance: appliance.appliance,
            claimedAtEpochMs: nowEpochMs,
            expiresAtEpochMs:
              nowEpochMs + this.queueClaimTtlMs,
          });
        if (queueEntry === null) continue;
        const event = queueAvailabilityEvent(
          appliance,
          queueEntry,
          nowEpochMs,
        );
        const intents =
          this.dependencies.planner.planLaundryTransition(event, {
            watches: [],
            queueEntry,
          });
        planned += intents.length;
        inserted += enqueue(
          this.dependencies.notifications,
          intents,
          nowEpochMs,
        );
      }
      return { planned, inserted };
    });
    return run.immediate();
  }
}

function enqueue(
  repository: NotificationRepository,
  intents: ReturnType<
    ServerNotificationPlanner["planLaundryTransition"]
  >,
  createdAtEpochMs: number,
): number {
  let inserted = 0;
  for (const intent of intents) {
    if (repository.enqueueIntent(intent, createdAtEpochMs).inserted) {
      inserted += 1;
    }
  }
  return inserted;
}

function becameAvailable(event: LaundryTransitionEvent): boolean {
  return (
    event.currentState === "AVAILABLE" &&
    event.previousState !== null &&
    event.previousState !== "AVAILABLE"
  );
}

function isTerminalForWatch(
  event: LaundryTransitionEvent,
  watch: LaundryWatch,
): boolean {
  if (
    watch.sessionId === null &&
    watch.notifyWhenAvailable &&
    becameAvailable(event)
  ) {
    return true;
  }
  if (
    watch.sessionId !== null &&
    watch.sessionId === event.sessionId &&
    (event.currentState === "COMPLETED" ||
      becameAvailable(event))
  ) {
    return true;
  }
  return false;
}

function availableAppliances(
  snapshot: LaundryResponse,
): LaundryAppliance[] {
  const result: LaundryAppliance[] = [];
  for (const machine of snapshot.machines) {
    for (const appliance of [machine.washer, machine.dryer]) {
      if (appliance !== null && isAvailable(appliance)) {
        result.push(appliance);
      }
    }
  }
  return result.sort(
    (left, right) =>
      left.machineId.localeCompare(right.machineId) ||
      left.appliance.localeCompare(right.appliance),
  );
}

function isAvailable(appliance: LaundryAppliance): boolean {
  return (
    appliance.operationalStatus === "IDLE" ||
    (appliance.operationalStatus === "UNKNOWN" &&
      appliance.projection.status === "IDLE")
  );
}

function queueAvailabilityEvent(
  appliance: LaundryAppliance,
  entry: LaundryQueueEntry,
  nowEpochMs: number,
): LaundryTransitionEvent {
  return {
    kind: "laundry-transition",
    sourceEventId:
      `laundry-queue:${entry.id}:${appliance.machineId}:${appliance.appliance}`,
    machineId: appliance.machineId,
    appliance: appliance.appliance,
    sessionId: appliance.sessionId,
    previousState: "UNKNOWN",
    currentState: "AVAILABLE",
    remainingMinutes: 0,
    occurredAtEpochMs: nowEpochMs,
  };
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Laundry lifecycle time is invalid.");
  }
}
