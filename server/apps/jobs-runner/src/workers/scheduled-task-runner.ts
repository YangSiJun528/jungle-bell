export interface ScheduledTask {
  name: string;
  run(): Promise<unknown>;
}

/** Runs scheduler stages sequentially while isolating failures by stage. */
export async function runIndependentScheduledTasks(
  tasks: readonly ScheduledTask[],
  onError: (name: string, error: Error) => void,
): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const task of tasks) {
    try {
      await task.run();
      succeeded.push(task.name);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failed.push(task.name);
      onError(task.name, error);
    }
  }
  return { succeeded, failed };
}
