import type {
  ScheduledTask,
  TaskContext,
  TaskFn,
} from "node-cron";
import { describe, expect, it, vi } from "vitest";

import { NotificationOutboxWorker } from "./worker.js";

describe("NotificationOutboxWorker maintenance wake", () => {
  it("runs retention at startup and at most once per configured interval", async () => {
    let now = 1_000;
    let callback: TaskFn | null = null;
    const runner = { runDue: vi.fn(async () => undefined) };
    const maintenance = { prune: vi.fn(() => undefined) };
    const scheduledTask = {
      start: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        if (callback === null) throw new Error("TASK_NOT_CREATED");
        return callback(context(now));
      }),
      stop: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as unknown as ScheduledTask;
    const worker = new NotificationOutboxWorker({
      runner,
      maintenance,
      maintenanceIntervalMs: 60_000,
      now: () => now,
      cron: {
        createTask(_expression, task) {
          callback = task;
          return scheduledTask;
        },
      },
    });

    await worker.start();
    expect(runner.runDue).toHaveBeenCalledTimes(1);
    expect(maintenance.prune).toHaveBeenCalledWith(1_000);

    now = 60_999;
    await callback!(context(now));
    expect(runner.runDue).toHaveBeenCalledTimes(2);
    expect(maintenance.prune).toHaveBeenCalledTimes(1);

    now = 61_000;
    await callback!(context(now));
    expect(maintenance.prune).toHaveBeenNthCalledWith(2, 61_000);

    await worker.stop();
    expect(scheduledTask.stop).toHaveBeenCalledOnce();
    expect(scheduledTask.destroy).toHaveBeenCalledOnce();
  });

  it("logs retry and terminal failure counts returned by the durable runner", async () => {
    let callback: TaskFn | null = null;
    const logger = { warn: vi.fn() };
    const scheduledTask = {
      start: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        if (callback === null) throw new Error("TASK_NOT_CREATED");
        return callback(context(1_000));
      }),
      stop: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as unknown as ScheduledTask;
    const worker = new NotificationOutboxWorker({
      runner: {
        runDue: vi.fn(async () => ({
          fannedOut: 2,
          delivered: 1,
          retried: 3,
          failed: 4,
        })),
      },
      logger,
      cron: {
        createTask(_expression, task) {
          callback = task;
          return scheduledTask;
        },
      },
    });

    await worker.start();
    expect(logger.warn).toHaveBeenCalledWith(
      "notification outbox delivery outcomes: retried=3 failed=4",
    );
    await worker.stop();
  });
});

function context(nowEpochMs: number): TaskContext {
  const date = new Date(nowEpochMs);
  return {
    date,
    dateLocalIso: date.toISOString(),
    triggeredAt: date,
  };
}
