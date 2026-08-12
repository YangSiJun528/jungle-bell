import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_splitSqlQuery, type TestHarness } from "wrangler";
import type { ApiBindings } from "../src/http/types";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));

describe("API Worker in the official Wrangler test harness", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createTestHarness({
      root: serverRoot,
      workers: [{ configPath: "wrangler.test.jsonc" }],
    });
    await harness.listen();
    const worker = harness.getWorker<ApiBindings>();
    const environment = await worker.getEnv();
    const schema = unstable_splitSqlQuery(await readFile(schemaPath, "utf8"));
    await environment.DB.batch(schema.map((sql) => environment.DB.prepare(sql)));
  }, 30_000);

  afterAll(async () => {
    await harness.close();
  });

  it("runs the current health route against real workerd, D1, and R2 bindings", async () => {
    const worker = harness.getWorker<ApiBindings>();
    const environment = await worker.getEnv();

    await expect(environment.DB.prepare("SELECT count(*) AS count FROM source_state").first<number>("count"))
      .resolves.toBe(0);
    await expect(environment.DATA_BUCKET.put("harness-check", "ready")).resolves.toBeDefined();
    await expect(environment.DATA_BUCKET.get("harness-check")).resolves.toMatchObject({ key: "harness-check" });

    const response = await worker.fetch("/api/health");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "DEGRADED", sources: [] });
  });
});
