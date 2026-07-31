import cron, {
  type ScheduledTask,
  type TaskFn,
  type TaskOptions,
} from "node-cron";
import {
  RETENTION_PRUNE_INTERVAL_MS,
} from "../infra/sqlite/retention.js";

export interface NotificationDueRunner {
  runDue(): Promise<unknown>;
}

export interface RetentionMaintenanceRunner {
  prune(nowEpochMs: number): unknown | Promise<unknown>;
}

interface CronAdapter {
  createTask(
    expression: string,
    task: TaskFn,
    options?: TaskOptions,
  ): ScheduledTask;
}

/**
 * node-cron is only a wake-up source. Durable due time, leases and retries live
 * in notification_outbox/notification_deliveries.
 */
export class NotificationOutboxWorker {
  private task: ScheduledTask | null = null;
  private active: Promise<void> | null = null;
  private accepting = false;
  private nextMaintenanceAtEpochMs = 0;
  private readonly now: () => number;
  private readonly maintenanceIntervalMs: number;

  constructor(
    private readonly dependencies: {
      readonly runner: NotificationDueRunner;
      readonly maintenance?: RetentionMaintenanceRunner;
      readonly maintenanceIntervalMs?: number;
      readonly now?: () => number;
      readonly cron?: CronAdapter;
      readonly logger?: { warn(message: string): void };
    },
  ) {
    this.now = dependencies.now ?? Date.now;
    this.maintenanceIntervalMs =
      dependencies.maintenanceIntervalMs ??
      RETENTION_PRUNE_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.maintenanceIntervalMs) ||
      this.maintenanceIntervalMs < 60_000
    ) {
      throw new TypeError(
        "Notification maintenance interval is invalid.",
      );
    }
  }

  async start(): Promise<void> {
    if (this.task !== null) return;
    const task = (this.dependencies.cron ?? cron).createTask(
      "* * * * * *",
      () => this.wake(),
      {
        name: "notification-outbox-wakeup",
        noOverlap: true,
        timezone: "UTC",
        unref: true,
      },
    );
    this.task = task;
    this.accepting = true;
    await task.start();
    await task.execute();
  }

  async stop(): Promise<void> {
    const task = this.task;
    this.task = null;
    this.accepting = false;
    if (task === null) {
      await this.active;
      return;
    }
    await task.stop();
    await this.active;
    await task.destroy();
  }

  private wake(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    if (this.active !== null) return this.active;
    const nowEpochMs = this.now();
    const runMaintenance =
      this.dependencies.maintenance !== undefined &&
      nowEpochMs >= this.nextMaintenanceAtEpochMs;
    if (runMaintenance) {
      this.nextMaintenanceAtEpochMs =
        nowEpochMs + this.maintenanceIntervalMs;
    }
    const running = (async () => {
      try {
        const result = await this.dependencies.runner.runDue();
        const outcome = parseRunOutcome(result);
        if (
          outcome !== null &&
          (outcome.retried > 0 || outcome.failed > 0)
        ) {
          this.dependencies.logger?.warn(
            `notification outbox delivery outcomes: retried=${outcome.retried} failed=${outcome.failed}`,
          );
        }
      } catch {
        this.dependencies.logger?.warn(
          "notification outbox batch failed",
        );
      }
      if (runMaintenance) {
        try {
          await this.dependencies.maintenance?.prune(nowEpochMs);
        } catch {
          this.dependencies.logger?.warn(
            "retention maintenance failed",
          );
        }
      }
    })();
    this.active = running;
    void running.finally(() => {
      if (this.active === running) this.active = null;
    });
    return running;
  }
}

function parseRunOutcome(
  value: unknown,
): { readonly retried: number; readonly failed: number } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("retried" in value) ||
    !("failed" in value) ||
    typeof value.retried !== "number" ||
    !Number.isSafeInteger(value.retried) ||
    value.retried < 0 ||
    typeof value.failed !== "number" ||
    !Number.isSafeInteger(value.failed) ||
    value.failed < 0
  ) {
    return null;
  }
  return { retried: value.retried, failed: value.failed };
}
