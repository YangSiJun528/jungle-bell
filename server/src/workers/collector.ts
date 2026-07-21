import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { collectAll } from "../collector/collector";
import { datedObjectPath } from "../collector/time";
import { collectorOptionsFromEnv, type CollectorEnvironment } from "./collector-config";
import { configureWorkerLogging } from "./logging";

interface Env extends CollectorEnvironment {
  DATA_BUCKET: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();
const logger = getLogger(["jungle-bell", "collector-worker"]);

app.get("/healthz", (context) => context.json({ status: "OK", role: "collector" }));
app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));

async function writeLog(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function runCollection(env: Env, scheduledAt: Date): Promise<void> {
  await configureWorkerLogging();
  const startedAt = new Date();
  try {
    const result = await collectAll(env.DATA_BUCKET, collectorOptionsFromEnv(env), scheduledAt);
    const completedAt = new Date();
    const logKey = datedObjectPath(
      "logs/collector-runs",
      startedAt,
      `${startedAt.toISOString().replaceAll(/[-:.]/g, "")}.json`,
    );
    await writeLog(env.DATA_BUCKET, logKey, {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...result,
    });
    logger.info("Collector run completed", { scheduledAt: result.scheduledAt, results: result.results, logKey });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedAt = new Date();
    const logKey = datedObjectPath(
      "logs/collector-runs",
      startedAt,
      `${startedAt.toISOString().replaceAll(/[-:.]/g, "")}-failed.json`,
    );
    try {
      await writeLog(env.DATA_BUCKET, logKey, {
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
    logger.error("Collector run crashed", { error: errorMessage, logKey });
    throw error;
  }
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, context);
  },

  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(runCollection(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
