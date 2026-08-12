import { getLogger } from "@logtape/logtape";
import { datedObjectPath, minuteEpoch } from "@jungle-bell/backend-common/collection/time";
import type { CollectAllResult, SourceName } from "@jungle-bell/backend-common/collection/types";
import { deliverDuePushes } from "@jungle-bell/backend-common/renewal/push-sender";
import { NodeWebPushSender } from "../clients/web-push-sender";
import {
  loadJobsConfiguration,
  type JobsEnvironment,
} from "../configuration/jobs-configuration";
import { planAttendanceNotifications } from "../services/attendance-notification-service";
import { runLaundryLifecycle } from "../services/laundry-lifecycle-service";
import { runMealPublicationLifecycle } from "../services/meal-publication-service";
import { collectSources } from "../services/source-collection-service";
import { createJobsStorage } from "../storage/jobs-storage";
import { runJobsCycle, type JobsClock } from "./jobs-cycle";

function collectionSources(scheduledAt: Date, mealsEveryMinutes: number): SourceName[] {
  const sources: SourceName[] = ["laundry"];
  if (minuteEpoch(scheduledAt) % mealsEveryMinutes === 0) {
    sources.push("meals-include-pinned", "meals-default");
  }
  return sources;
}

function jobsLogKey(startedAt: Date, failed: boolean): string {
  const suffix = failed ? "-failed" : "";
  return datedObjectPath(
    "logs/jobs-runs",
    startedAt,
    `${startedAt.toISOString().replaceAll(/[-:.]/gu, "")}${suffix}.json`,
  );
}

/** Executes one scheduled collection and notification cycle. */
export async function executeJobs(
  environment: JobsEnvironment,
  scheduledAt: Date,
  clock: JobsClock = Date.now,
): Promise<{ succeeded: string[]; failed: string[] }> {
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("--scheduled-at must be RFC3339");
  const configuration = await loadJobsConfiguration(environment);
  const storage = createJobsStorage(configuration);
  const sender = new NodeWebPushSender(configuration.vapid);
  const logger = getLogger(["jungle-bell", "oci-jobs"]);
  const startedAt = new Date(clock());
  let collection: CollectAllResult | null = null;
  const failures: Array<{ stage: string; error: string }> = [];

  const result = await runJobsCycle({
    collector: async () => {
      collection = await collectSources(
        storage.collector,
        configuration.collector,
        collectionSources(scheduledAt, configuration.mealsEveryMinutes),
        scheduledAt,
        () => new Date(clock()),
      );
      const failedSources = collection.results.filter((item) => item.status === "FAILED");
      if (failedSources.length > 0) {
        throw new Error(`Collection failed: ${failedSources.map((item) => item.source).join(", ")}`);
      }
    },
    attendance: (nowEpochMs) => planAttendanceNotifications(storage.renewal, nowEpochMs),
    meals: (nowEpochMs) => runMealPublicationLifecycle(storage.renewal, nowEpochMs),
    laundry: (nowEpochMs) => runLaundryLifecycle(storage.renewal, storage.collector, nowEpochMs),
    housekeeping: (nowEpochMs) => storage.renewal.runHousekeeping(nowEpochMs),
    push: (nowEpochMs) => deliverDuePushes(storage.renewal, sender, nowEpochMs),
    onError: (stage, error) => {
      failures.push({ stage, error: error.message });
      logger.error("OCI Jobs stage failed", { stage, error: error.message });
    },
  }, clock);

  const completedAt = new Date(clock());
  const logKey = jobsLogKey(startedAt, result.failed.length > 0);
  await storage.collector.writeJson(logKey, {
    deployment: configuration.deployment,
    scheduledAt: scheduledAt.toISOString(),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    collection,
    ...result,
    failures,
  });
  logger.info("OCI Jobs cycle completed", { deployment: configuration.deployment, logKey, ...result });
  return result;
}
