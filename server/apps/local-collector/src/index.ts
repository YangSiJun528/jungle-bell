#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getTimeRotatingFileSink } from "@logtape/file";
import {
  configure,
  dispose,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
} from "@logtape/logtape";
import { Command } from "commander";
import {
  collectAll,
  collectorOptionsFromEnv,
  type CollectorEnvironment,
} from "../../../packages/collector-core/src";
import { FileSystemStorage } from "../../../packages/storage-filesystem/src";

interface CollectCommandOptions {
  dataDir: string;
  scheduledAt?: string;
}

async function collect(options: CollectCommandOptions): Promise<void> {
  const dataDir = resolve(options.dataDir);
  const logsDir = resolve(dataDir, "logs");
  for (const directory of ["assets", "events", "indexes", "logs", "observations", "raw", "versions"]) {
    await mkdir(resolve(dataDir, directory), { recursive: true });
  }
  await configure({
    sinks: {
      console: getConsoleSink(),
      file: getTimeRotatingFileSink({
        directory: logsDir,
        interval: "daily",
        filename: (date) => `${date.toISOString().slice(0, 10)}.jsonl`,
        formatter: getJsonLinesFormatter(),
        flushInterval: 1_000,
      }),
    },
    loggers: [
      { category: ["jungle-bell"], lowestLevel: "info", sinks: ["console", "file"] },
      { category: ["logtape"], lowestLevel: "error", sinks: ["console", "file"] },
    ],
  });

  const logger = getLogger(["jungle-bell", "local-collector"]);
  try {
    const scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) throw new Error("--scheduled-at must be RFC3339");
    const storage = new FileSystemStorage(dataDir);
    const result = await collectAll(
      storage,
      collectorOptionsFromEnv(process.env as CollectorEnvironment),
      scheduledAt,
    );
    logger.info("Local collection completed", { dataDir, ...result });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.results.some((item) => item.status === "FAILED")) process.exitCode = 1;
  } catch (error) {
    logger.error("Local collection crashed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await dispose();
  }
}

const program = new Command()
  .name("jungle-bell-collector")
  .description("Archive Jungle Bell upstream data using a local filesystem adapter")
  .showHelpAfterError();

program
  .command("collect")
  .description("run one sequential collection cycle")
  .option("--data-dir <path>", "archive root", process.env.DATA_DIR ?? "/data")
  .option("--scheduled-at <rfc3339>", "override the minute represented by this run")
  .action(collect);

await program.parseAsync(process.argv);
