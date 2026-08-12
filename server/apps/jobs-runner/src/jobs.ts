#!/usr/bin/env node
import { dispose, getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { configureServerLogging } from "@jungle-bell/backend-common/observability/logging";
import type { JobsEnvironment } from "./configuration/jobs-configuration";
import { executeJobs } from "./workers/scheduled-jobs-worker";

interface RunCommandOptions {
  scheduledAt?: string;
}

async function run(options: RunCommandOptions): Promise<void> {
  await configureServerLogging();
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
