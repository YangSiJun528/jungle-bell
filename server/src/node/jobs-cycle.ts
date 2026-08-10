import { runIndependentScheduledTasks } from "../application/scheduled-renewal";

export interface JobsCycleTasks {
  collector(): Promise<unknown>;
  attendance(nowEpochMs: number): Promise<unknown>;
  meals(nowEpochMs: number): Promise<unknown>;
  laundry(nowEpochMs: number): Promise<unknown>;
  housekeeping(nowEpochMs: number): Promise<unknown>;
  push(nowEpochMs: number): Promise<unknown>;
  onError(name: string, error: Error): void;
}

export type JobsClock = () => number;

/** Runs one flock-protected OCI cycle in the only supported stage order. */
export async function runJobsCycle(
  tasks: JobsCycleTasks,
  clock: JobsClock = Date.now,
): Promise<{ succeeded: string[]; failed: string[] }> {
  return runIndependentScheduledTasks([
    { name: "collector", run: tasks.collector },
    { name: "attendance", run: () => tasks.attendance(clock()) },
    { name: "meals", run: () => tasks.meals(clock()) },
    { name: "laundry", run: () => tasks.laundry(clock()) },
    { name: "housekeeping", run: () => tasks.housekeeping(clock()) },
    { name: "push", run: () => tasks.push(clock()) },
  ], tasks.onError);
}
