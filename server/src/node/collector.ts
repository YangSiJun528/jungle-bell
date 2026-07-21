#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dispose, getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { collectSources } from "../collector/collector";
import { datedObjectPath, minuteEpoch } from "../collector/time";
import type { SourceName } from "../collector/types";
import {
  collectorOptionsFromEnv,
  type CollectorEnvironment,
} from "../workers/collector-config";
import { configureWorkerLogging } from "../workers/logging";
import { CloudflareRestStorage } from "./cloudflare-rest-storage";

interface RuntimeEnvironment extends CollectorEnvironment {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
  CLOUDFLARE_D1_API_TOKEN?: string;
  CLOUDFLARE_D1_API_TOKEN_FILE?: string;
  CLOUDFLARE_API_TIMEOUT_MS?: string;
  CLOUDFLARE_API_RETRIES?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCESS_KEY_ID_FILE?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_SECRET_ACCESS_KEY_FILE?: string;
}

interface CollectCommandOptions {
  mealsEveryMinutes: string;
  scheduledAt?: string;
}

function integer(value: string, name: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

async function secretValue(
  environment: RuntimeEnvironment,
  valueName: keyof RuntimeEnvironment,
  fileName: keyof RuntimeEnvironment,
): Promise<string> {
  const file = environment[fileName]?.trim();
  if (file) return requiredValue(await readFile(file, "utf8"), String(fileName));
  return requiredValue(environment[valueName], String(valueName));
}

async function createStorage(environment: RuntimeEnvironment): Promise<CloudflareRestStorage> {
  const accountId = requiredValue(environment.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  return new CloudflareRestStorage({
    accountId,
    databaseId: requiredValue(environment.CLOUDFLARE_D1_DATABASE_ID, "CLOUDFLARE_D1_DATABASE_ID"),
    apiToken: await secretValue(environment, "CLOUDFLARE_D1_API_TOKEN", "CLOUDFLARE_D1_API_TOKEN_FILE"),
    r2Bucket: requiredValue(environment.R2_BUCKET, "R2_BUCKET"),
    r2AccessKeyId: await secretValue(environment, "R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID_FILE"),
    r2SecretAccessKey: await secretValue(
      environment,
      "R2_SECRET_ACCESS_KEY",
      "R2_SECRET_ACCESS_KEY_FILE",
    ),
    r2Endpoint: environment.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    requestTimeoutMs: integer(environment.CLOUDFLARE_API_TIMEOUT_MS ?? "30000", "CLOUDFLARE_API_TIMEOUT_MS", 1),
    requestRetries: integer(environment.CLOUDFLARE_API_RETRIES ?? "3", "CLOUDFLARE_API_RETRIES", 0),
  });
}

function sourcesFor(scheduledAt: Date, mealsEveryMinutes: number): SourceName[] {
  const sources: SourceName[] = ["laundry"];
  if (minuteEpoch(scheduledAt) % mealsEveryMinutes === 0) {
    sources.push("meals-include-pinned", "meals-default");
  }
  return sources;
}

async function collect(options: CollectCommandOptions): Promise<void> {
  await configureWorkerLogging();
  const logger = getLogger(["jungle-bell", "oci-collector"]);
  const environment = process.env as RuntimeEnvironment;
  let storage: CloudflareRestStorage | null = null;
  let startedAt: Date | null = null;

  try {
    const scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) throw new Error("--scheduled-at must be RFC3339");
    const mealsEveryMinutes = integer(options.mealsEveryMinutes, "--meals-every-minutes", 1);
    storage = await createStorage(environment);
    startedAt = new Date();
    const result = await collectSources(
      storage,
      collectorOptionsFromEnv(environment),
      sourcesFor(scheduledAt, mealsEveryMinutes),
      scheduledAt,
    );
    const completedAt = new Date();
    const logKey = datedObjectPath(
      "logs/collector-runs",
      startedAt,
      `${startedAt.toISOString().replaceAll(/[-:.]/g, "")}.json`,
    );
    await storage.writeJson(logKey, {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...result,
    });
    logger.info("Collector run completed", { logKey, ...result });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.results.some((item) => item.status === "FAILED")) process.exitCode = 1;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (storage && startedAt) {
      const failedAt = new Date();
      const logKey = datedObjectPath(
        "logs/collector-runs",
        startedAt,
        `${startedAt.toISOString().replaceAll(/[-:.]/g, "")}-failed.json`,
      );
      try {
        await storage.writeJson(logKey, {
          startedAt: startedAt.toISOString(),
          failedAt: failedAt.toISOString(),
          durationMs: failedAt.getTime() - startedAt.getTime(),
          error: errorMessage,
        });
      } catch (logError) {
        logger.error("Could not persist failed collector run", {
          error: logError instanceof Error ? logError.message : String(logError),
        });
      }
    }
    logger.error("Collector run crashed", { error: errorMessage });
    process.exitCode = 1;
  } finally {
    await dispose();
  }
}

const program = new Command()
  .name("jungle-bell-collector")
  .description("Collect Jungle Bell data on OCI and store it directly in Cloudflare D1 and R2")
  .showHelpAfterError();

program
  .command("collect")
  .description("run one sequential collection cycle")
  .option(
    "--meals-every-minutes <minutes>",
    "collect both Kakao sources every N minutes while collecting laundry every run",
    process.env.MEALS_EVERY_MINUTES ?? "5",
  )
  .option("--scheduled-at <rfc3339>", "override the minute represented by this run")
  .action(collect);

await program.parseAsync(process.argv);
