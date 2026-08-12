import { readFile } from "node:fs/promises";
import type { CollectorOptions } from "@jungle-bell/backend-common/collection/types";
import {
  collectorOptionsFromEnv,
  type CollectorEnvironment,
} from "./collector-configuration";

const GATEWAY_URLS: Record<JobsDeployment, string> = {
  production: "https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/d1",
  "v2-test": "https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/d1",
};

export type JobsDeployment = "production" | "v2-test";

export interface JobsEnvironment extends CollectorEnvironment {
  JUNGLE_BELL_ENVIRONMENT?: string;
  JOBS_D1_GATEWAY_URL?: string;
  JOBS_D1_GATEWAY_SECRET_FILE?: string;
  D1_GATEWAY_TIMEOUT_MS?: string;
  D1_GATEWAY_RETRIES?: string;
  VAPID_PUBLIC_KEY_FILE?: string;
  VAPID_PRIVATE_KEY_FILE?: string;
  VAPID_SUBJECT?: string;
  MEALS_EVERY_MINUTES?: string;
}

export interface JobsConfiguration {
  deployment: JobsDeployment;
  collector: CollectorOptions;
  mealsEveryMinutes: number;
  d1: {
    url: string;
    sharedSecret: string;
    requestTimeoutMs: number;
    requestRetries: number;
  };
  storage: {
    r2GatewayUrl: string;
    sharedSecret: string;
    r2RequestTimeoutMs: number;
    r2RequestRetries: number;
  };
  vapid: {
    subject: string;
    publicKey: string;
    privateKey: string;
  };
}

type SecretFileReader = (path: string) => Promise<string>;

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function integer(value: string | undefined, name: string, minimum: number, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

async function secretFile(
  environment: JobsEnvironment,
  fileName: keyof JobsEnvironment,
  readSecretFile: SecretFileReader,
): Promise<string> {
  const file = required(environment[fileName], String(fileName));
  return required(await readSecretFile(file), String(fileName));
}

function deployment(value: string | undefined): JobsDeployment {
  if (value === "production" || value === "v2-test") return value;
  throw new Error("JUNGLE_BELL_ENVIRONMENT must be production or v2-test");
}

function assertIsolatedTarget(target: JobsDeployment, gatewayUrl: string): void {
  if (gatewayUrl !== GATEWAY_URLS[target]) {
    throw new Error(`${target} D1 gateway URL does not match the fixed target`);
  }
}

function r2GatewayUrl(d1GatewayUrl: string): string {
  const url = new URL(d1GatewayUrl);
  url.pathname = "/internal/jobs/r2";
  return url.toString();
}

export async function loadJobsConfiguration(
  environment: JobsEnvironment,
  readSecretFile: SecretFileReader = (path) => readFile(path, "utf8"),
): Promise<JobsConfiguration> {
  const target = deployment(environment.JUNGLE_BELL_ENVIRONMENT);
  const gatewayUrl = required(environment.JOBS_D1_GATEWAY_URL, "JOBS_D1_GATEWAY_URL");
  assertIsolatedTarget(target, gatewayUrl);
  const gatewaySecret = await secretFile(environment, "JOBS_D1_GATEWAY_SECRET_FILE", readSecretFile);
  if (gatewaySecret.length < 32) throw new Error("JOBS_D1_GATEWAY_SECRET_FILE must contain at least 32 characters");
  const publicKey = await secretFile(environment, "VAPID_PUBLIC_KEY_FILE", readSecretFile);
  const privateKey = await secretFile(environment, "VAPID_PRIVATE_KEY_FILE", readSecretFile);
  const gatewayTimeoutMs = integer(
    environment.D1_GATEWAY_TIMEOUT_MS, "D1_GATEWAY_TIMEOUT_MS", 1, 30_000,
  );
  const gatewayRetries = integer(
    environment.D1_GATEWAY_RETRIES, "D1_GATEWAY_RETRIES", 0, 3,
  );
  return {
    deployment: target,
    collector: collectorOptionsFromEnv(environment),
    mealsEveryMinutes: integer(environment.MEALS_EVERY_MINUTES, "MEALS_EVERY_MINUTES", 1, 5),
    d1: {
      url: gatewayUrl,
      sharedSecret: gatewaySecret,
      requestTimeoutMs: gatewayTimeoutMs,
      requestRetries: gatewayRetries,
    },
    storage: {
      r2GatewayUrl: r2GatewayUrl(gatewayUrl),
      sharedSecret: gatewaySecret,
      r2RequestTimeoutMs: gatewayTimeoutMs,
      r2RequestRetries: gatewayRetries,
    },
    vapid: {
      subject: required(environment.VAPID_SUBJECT, "VAPID_SUBJECT"),
      publicKey,
      privateKey,
    },
  };
}
