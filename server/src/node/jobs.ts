#!/usr/bin/env node
import { dispose, getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { runLaundryLifecycle } from "../application/laundry-lifecycle";
import { runMealPublicationLifecycle } from "../application/meal-lifecycle";
import { collectSources } from "../collector/collector";
import { datedObjectPath, minuteEpoch } from "../collector/time";
import type { CollectAllResult, SourceName } from "../collector/types";
import { planAttendanceNotifications } from "../renewal/notification-planner";
import { deliverDuePushes } from "../renewal/push-sender";
import { D1RenewalStore } from "../workers/account-storage";
import { configureWorkerLogging } from "../workers/logging";
import { CloudflareRestStorage } from "./cloudflare-rest-storage";
import { D1GatewayDatabase } from "./d1-gateway-database";
import { loadJobsConfiguration, type JobsEnvironment } from "./jobs-config";
import { runJobsCycle, type JobsClock } from "./jobs-cycle";
import { NodeWebPushSender } from "./web-push-sender";

interface RunCommandOptions {
  scheduledAt?: string;
}

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

export async function executeJobs(
  environment: JobsEnvironment,
  scheduledAt: Date,
  clock: JobsClock = Date.now,
): Promise<{ succeeded: string[]; failed: string[] }> {
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("--scheduled-at must be RFC3339");
  const configuration = await loadJobsConfiguration(environment);
  const database = new D1GatewayDatabase(configuration.d1);
  const storage = new CloudflareRestStorage(configuration.storage, { d1: database });
  const store = new D1RenewalStore(database as unknown as D1Database);
  const sender = new NodeWebPushSender(configuration.vapid);
  const logger = getLogger(["jungle-bell", "oci-jobs"]);
  const startedAt = new Date(clock());
  let collection: CollectAllResult | null = null;
  const failures: Array<{ stage: string; error: string }> = [];

  const result = await runJobsCycle({
    collector: async () => {
      collection = await collectSources(
        storage,
        configuration.collector,
        collectionSources(scheduledAt, configuration.mealsEveryMinutes),
        scheduledAt,
      );
      const failedSources = collection.results.filter((item) => item.status === "FAILED");
      if (failedSources.length > 0) {
        throw new Error(`Collection failed: ${failedSources.map((item) => item.source).join(", ")}`);
      }
    },
    attendance: (nowEpochMs) => planAttendanceNotifications(store, nowEpochMs),
    meals: (nowEpochMs) => runMealPublicationLifecycle(store, nowEpochMs),
    laundry: (nowEpochMs) => runLaundryLifecycle(store, storage, nowEpochMs),
    housekeeping: (nowEpochMs) => store.runHousekeeping(nowEpochMs),
    push: (nowEpochMs) => deliverDuePushes(store, sender, nowEpochMs),
    onError: (stage, error) => {
      failures.push({ stage, error: error.message });
      logger.error("OCI Jobs stage failed", { stage, error: error.message });
    },
  }, clock);

  const completedAt = new Date(clock());
  const logKey = jobsLogKey(startedAt, result.failed.length > 0);
  await storage.writeJson(logKey, {
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

async function run(options: RunCommandOptions): Promise<void> {
  await configureWorkerLogging();
  const logger = getLogger(["jungle-bell", "oci-jobs"]);
  try {
    const scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : new Date();
    const result = await executeJobs(process.env as JobsEnvironment, scheduledAt);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.failed.length > 0) process.exitCode = 1;
  } catch (error) {
    logger.error("OCI Jobs cycle crashed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await dispose();
  }
}

const program = new Command()
  .name("jungle-bell-jobs")
  .description("Run Jungle Bell collection, notification lifecycles, housekeeping, and Web Push on OCI")
  .showHelpAfterError();

program
  .command("run")
  .description("run one sequential Jobs cycle")
  .option("--scheduled-at <rfc3339>", "override the minute represented by this run")
  .action(run);

await program.parseAsync(process.argv);
