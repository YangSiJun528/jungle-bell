import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectorOptionsFromEnv, DEFAULT_COLLECTOR_URLS } from "../src/workers/collector-config";
import {
  DESKTOP_ENROLLMENT_POLICY,
  MANUAL_PAIRING_CLAIM_POLICY,
  PAIRING_CREATION_POLICY,
} from "../src/domain/enrollment-policy";

describe("collectorOptionsFromEnv", () => {
  const laundryUrl = "https://laundry.example.com/api/status";

  it("applies validated defaults", () => {
    const options = collectorOptionsFromEnv({ LAUNDRY_URL: laundryUrl });

    expect(options.urls).toEqual({
      laundry: laundryUrl,
      mealsIncludePinned: DEFAULT_COLLECTOR_URLS.mealsIncludePinned,
      mealsDefault: DEFAULT_COLLECTOR_URLS.mealsDefault,
      mealsPage: DEFAULT_COLLECTOR_URLS.mealsPage,
    });
    expect(options.requestTimeoutMs).toBe(30_000);
    expect(options.requestRetries).toBe(2);
  });

  it("normalizes comma-separated and JSON LG run states", () => {
    expect(collectorOptionsFromEnv({ LAUNDRY_URL: laundryUrl, LG_RUN_STATES: "running, END, running" }).lgRunStates)
      .toEqual(["RUNNING", "END"]);
    expect(collectorOptionsFromEnv({ LAUNDRY_URL: laundryUrl, LG_RUN_STATES: '["power_off", "error"]' }).lgRunStates)
      .toEqual(["POWER_OFF", "ERROR"]);
  });

  it("rejects invalid URLs and numeric settings", () => {
    expect(() => collectorOptionsFromEnv({})).toThrow();
    expect(() => collectorOptionsFromEnv({ LAUNDRY_URL: "not-a-url" })).toThrow();
    expect(() => collectorOptionsFromEnv({ LAUNDRY_URL: "http://laundry.example.com/api/status" })).toThrow();
    expect(() => collectorOptionsFromEnv({
      LAUNDRY_URL: laundryUrl,
      MEALS_DEFAULT_URL: "http://meals.example.com/posts",
    })).toThrow();
    expect(() => collectorOptionsFromEnv({ LAUNDRY_URL: laundryUrl, REQUEST_TIMEOUT_MS: "0" })).toThrow();
    expect(() => collectorOptionsFromEnv({ LAUNDRY_URL: laundryUrl, REQUEST_RETRIES: "1.5" })).toThrow();
  });

  it("rejects malformed LG run states", () => {
    expect(() => collectorOptionsFromEnv({ LAUNDRY_URL: laundryUrl, LG_RUN_STATES: '["RUNNING", 1]' })).toThrow(
      "LG_RUN_STATES must be a JSON array or comma-separated list of strings",
    );
  });
});

describe("test Worker resource isolation", () => {
  it("requires a new blue/green production D1 and R2 instead of the existing collector resources", () => {
    const productionConfig = JSON.parse(readFileSync(new URL("../wrangler.api.jsonc", import.meta.url), "utf8")) as {
      d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
      r2_buckets: Array<{ binding: string; bucket_name: string }>;
    };
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(productionConfig.d1_databases[0]).toEqual({
      binding: "DB", database_name: "jungle-bell-v2", database_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(productionConfig.r2_buckets[0]).toEqual({ binding: "DATA_BUCKET", bucket_name: "jungle-bell-v2" });
    expect(packageJson.scripts).not.toHaveProperty("db:reset:remote");
  });

  it("uses deployable test-only D1/R2 resources without touching the legacy production database", () => {
    const testConfig = JSON.parse(readFileSync(new URL("../wrangler.api-test.jsonc", import.meta.url), "utf8")) as {
      d1_databases: Array<{ database_name: string; database_id: string }>;
      r2_buckets: Array<{ bucket_name: string }>;
      services?: unknown;
      triggers?: unknown;
    };
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(testConfig.d1_databases[0]).toEqual({
      binding: "DB",
      database_name: "jungle-bell-v2-test",
      database_id: "944236f8-3833-48f5-96cf-959770600526",
    });
    expect(testConfig.r2_buckets[0]).toEqual({ binding: "DATA_BUCKET", bucket_name: "jungle-bell-v2-test" });
    expect(testConfig).not.toHaveProperty("services");
    expect(testConfig).not.toHaveProperty("triggers");
    expect(packageJson.scripts["deploy:api:test"]).toContain("wrangler.api-test.jsonc");
    expect(packageJson.scripts["predeploy:api"]).toBe(
      "cross-env JUNGLE_BELL_PUBLIC_ORIGIN=https://jungle-bell-api.yangsijun5528.workers.dev npm --prefix .. run build",
    );
    expect(packageJson.scripts["predeploy:api:test"]).toBe(
      "cross-env JUNGLE_BELL_PUBLIC_ORIGIN=https://jungle-bell-api-test.yangsijun5528.workers.dev npm --prefix .. run build",
    );
  });

  it("keeps both App Workers HTTP-only and removes the relay deployment surface", () => {
    const apiConfig = JSON.parse(readFileSync(new URL("../wrangler.api.jsonc", import.meta.url), "utf8")) as {
      main: string;
      services?: unknown;
      triggers?: unknown;
    };
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    const pushSender = readFileSync(new URL("../src/renewal/push-sender.ts", import.meta.url), "utf8");
    const localWorkerEnvironment = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");

    expect(apiConfig.main).toBe("src/workers/api.ts");
    expect(apiConfig).not.toHaveProperty("services");
    expect(apiConfig).not.toHaveProperty("triggers");
    expect(apiConfig).toMatchObject({
      assets: {
        html_handling: "none",
        run_worker_first: ["/", "/blog", "/blog/", "/api/*", "/internal/*"],
      },
    });
    expect(JSON.stringify(apiConfig)).not.toContain("WEB_PUSH_RELAY");
    expect(packageJson.scripts).not.toHaveProperty("deploy:push-relay");
    expect(packageJson.scripts).not.toHaveProperty("deploy:push-relay:test");
    expect(existsSync(new URL("../wrangler.push-relay.jsonc", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../wrangler.push-relay-test.jsonc", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/workers/web-push-relay.ts", import.meta.url))).toBe(false);
    expect(pushSender).not.toMatch(/RelaySender|WEB_PUSH_RELAY/u);
    expect(localWorkerEnvironment).not.toMatch(/WEB_PUSH_RELAY|VAPID_PRIVATE_KEY/u);
  });

  it("keeps one current schema with no LMS credential or legacy delivery tables", () => {
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    expect(schema).toContain("CREATE TABLE notification_delivery");
    expect(schema).toContain("CREATE TABLE desktop_enrollment_attempt");
    expect(schema).toContain("CREATE TABLE pairing_claim_attempt");
    expect(schema).toContain("CREATE TABLE pairing_creation_attempt");
    expect(schema).toContain("activated_at_epoch_ms INTEGER");
    expect(schema).toContain("CREATE TABLE meal_preference");
    expect(schema).toContain("CREATE TABLE laundry_watch");
    expect(schema).toContain("CREATE TABLE laundry_queue_entry");
    expect(schema).toContain("CREATE TABLE laundry_lifecycle_processing");
    expect(schema).not.toMatch(/lms_subject|access_token|refresh_token|CREATE TABLE push_delivery|source_version/u);
  });

  it("keeps collection writes in the OCI storage adapter only", () => {
    const apiStorage = readFileSync(new URL("../src/workers/cloudflare-storage.ts", import.meta.url), "utf8");
    const jobsStorage = readFileSync(new URL("../src/node/cloudflare-rest-storage.ts", import.meta.url), "utf8");

    expect(apiStorage).not.toMatch(/\bapplyCommit\s*\(/u);
    expect(jobsStorage).toContain('import { buildD1CommitQueries, type D1Query } from "../storage/d1-commit";');
    expect(jobsStorage).toMatch(/async commit\(commit: CollectionCommit\): Promise<void> \{\s+const queries = await buildD1CommitQueries\(commit\);/u);
  });

  it("keeps API and edge-operation rate contracts synchronized with the policy constants", () => {
    const apiReference = readFileSync(new URL("../docs/api-reference.md", import.meta.url), "utf8");
    const operations = readFileSync(new URL("../OPERATIONS.md", import.meta.url), "utf8");
    const minutes = (milliseconds: number) => milliseconds / 60_000;

    expect(apiReference).toContain(
      `Desktop 등록은 IP당 ${minutes(DESKTOP_ENROLLMENT_POLICY.windowMs)}분에 ${DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit}회`,
    );
    expect(apiReference).toContain(
      `수동 코드 claim은 IP당 ${minutes(MANUAL_PAIRING_CLAIM_POLICY.windowMs)}분에 ${MANUAL_PAIRING_CLAIM_POLICY.ipAttemptLimit}회`,
    );
    expect(apiReference).toContain(
      `페어링 생성은 인증된 desktop installation당 ${minutes(PAIRING_CREATION_POLICY.windowMs)}분에 ${PAIRING_CREATION_POLICY.installationAttemptLimit}회`,
    );
    expect(operations).toContain(
      `desktop 등록 IP당 ${DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit}회/${minutes(DESKTOP_ENROLLMENT_POLICY.windowMs)}분`,
    );
    expect(operations).toContain(
      `수동 claim IP당 ${MANUAL_PAIRING_CLAIM_POLICY.ipAttemptLimit}회/${minutes(MANUAL_PAIRING_CLAIM_POLICY.windowMs)}분`,
    );
  });
});

describe("v2-test OCI Jobs isolation", () => {
  it("builds and schedules only the monolithic OCI Jobs entrypoint", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    const crontab = readFileSync(new URL("../docker/crontab", import.meta.url), "utf8");

    expect(packageJson.scripts.build).toContain("src/node/jobs.ts");
    expect(packageJson.scripts["jobs:run"]).toContain("dist/jobs/jobs.js run");
    expect(packageJson.scripts).not.toHaveProperty("collector:collect");
    expect(existsSync(new URL("../src/node/collector.ts", import.meta.url))).toBe(false);
    expect(crontab).toBe(
      '* * * * * flock --nonblock --conflict-exit-code 75 /tmp/jungle-bell-jobs.lock node /app/dist/jobs/jobs.js run || test "$?" -eq 75\n',
    );
  });

  it("uses only the fixed v2-test resources and distinct runtime identities", () => {
    const compose = readFileSync(new URL("../docker-compose.oci-v2-test.yml", import.meta.url), "utf8");
    const environment = readFileSync(new URL("../.env.oci-v2-test.example", import.meta.url), "utf8");

    expect(compose).toContain("name: jungle-bell-v2-test");
    expect(compose).toMatch(/^  jobs-v2-test:\s*$/mu);
    expect(compose).toContain("container_name: jungle-bell-jobs-v2-test");
    expect(compose).toContain("image: ${JOBS_V2_TEST_IMAGE:-jungle-bell-jobs:v2-test-local}");
    expect(compose).toContain("JUNGLE_BELL_ENVIRONMENT: v2-test");
    expect(environment).toContain(
      "JOBS_D1_GATEWAY_URL=https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/d1",
    );
    expect(compose).not.toMatch(/R2_BUCKET|R2_ENDPOINT|R2_ACCESS_KEY|R2_SECRET_ACCESS_KEY/u);
    expect(compose).not.toMatch(/container_name:\s*jungle-bell-jobs\s*$/mu);
    expect(compose).not.toContain("image: jungle-bell-jobs:latest");

    const secretRoot = "/home/ubuntu/.config/jungle-bell-jobs-v2-test";
    expect(environment).toContain(`JOBS_D1_GATEWAY_SECRET_FILE=${secretRoot}/jobs-d1-gateway-secret`);
    expect(environment).toContain(`VAPID_PUBLIC_KEY_FILE=${secretRoot}/vapid-public-key`);
    expect(environment).toContain(`VAPID_PRIVATE_KEY_FILE=${secretRoot}/vapid-private-key`);
    expect(compose).toContain("${JOBS_D1_GATEWAY_SECRET_FILE:?set JOBS_D1_GATEWAY_SECRET_FILE}");
    expect(compose).toContain("${VAPID_PUBLIC_KEY_FILE:?set VAPID_PUBLIC_KEY_FILE}");
    expect(compose).toContain("${VAPID_PRIVATE_KEY_FILE:?set VAPID_PRIVATE_KEY_FILE}");
    expect(compose).not.toMatch(/CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_D1_DATABASE_ID|CLOUDFLARE_D1_API_TOKEN/u);
    expect(environment).not.toMatch(/CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_D1_DATABASE_ID|CLOUDFLARE_D1_API_TOKEN/u);
    expect(environment).not.toMatch(/R2_BUCKET|R2_ENDPOINT|R2_ACCESS_KEY|R2_SECRET_ACCESS_KEY/u);
    expect(compose).toContain("LAUNDRY_URL: ${LAUNDRY_URL:?set LAUNDRY_URL}");
    expect(environment).toContain("LAUNDRY_URL=https://laundry.example.com/api/status");
    expect(environment).not.toMatch(/^VAPID_PUBLIC_KEY=/mu);
    expect(environment).not.toMatch(/^VAPID_PRIVATE_KEY=/mu);
  });
});
