import cron, {
  type ScheduledTask,
  type TaskFn,
  type TaskOptions,
} from "node-cron";

export interface CampusDueRunner {
  refreshDue(): Promise<unknown>;
}
interface CronAdapter {
  createTask(
    expression: string,
    task: TaskFn,
    options?: TaskOptions,
  ): ScheduledTask;
}

export class CampusCollectionWorker {
  private task: ScheduledTask | null = null;
  private active: Promise<void> | null = null;
  private accepting = false;

  constructor(
    private readonly dependencies: {
      readonly runner: CampusDueRunner;
      readonly cron?: CronAdapter;
      readonly logger?: { warn(message: string): void };
    },
  ) {}

  async start(): Promise<void> {
    if (this.task !== null) return;
    const task = (this.dependencies.cron ?? cron).createTask(
      "* * * * * *",
      () => this.runOnce(),
      {
        name: "campus-collector-wakeup",
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

  private runOnce(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    if (this.active !== null) return this.active;
    const running = this.dependencies.runner
      .refreshDue()
      .then(() => undefined)
      .catch(() => {
        this.dependencies.logger?.warn("campus collection batch failed");
      });
    this.active = running;
    void running.finally(() => {
      if (this.active === running) this.active = null;
    });
    return running;
  }
}
