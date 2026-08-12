import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const layers = ["clients", "configuration", "services", "storage", "workers"] as const;
type Layer = typeof layers[number];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu)]
    .map((match) => resolve(dirname(file), match[1] ?? ""));
}

function layerOf(path: string): Layer | null {
  const first = relative(sourceRoot, path).split(sep)[0];
  return layers.find((layer) => layer === first) ?? null;
}

describe("Jobs Runner architecture", () => {
  it("keeps only the worker, service, storage, client, and configuration layers", () => {
    expect(sourceFiles(sourceRoot).map((file) => relative(sourceRoot, file)).sort()).toEqual([
      "clients/http-client.ts",
      "clients/meal-media.ts",
      "clients/web-push-sender.ts",
      "configuration/collector-configuration.ts",
      "configuration/jobs-configuration.ts",
      "jobs.ts",
      "services/attendance-notification-service.ts",
      "services/laundry-lifecycle-service.ts",
      "services/meal-publication-service.ts",
      "services/source-collection-service.ts",
      "storage/cloudflare-rest-storage.ts",
      "storage/d1-commit-queries.ts",
      "storage/d1-gateway-database.ts",
      "storage/jobs-storage.ts",
      "workers/jobs-cycle.ts",
      "workers/scheduled-jobs-worker.ts",
      "workers/scheduled-task-runner.ts",
    ]);
    for (const legacy of ["adapters", "collection", "config", "persistence", "renewal", "use-cases"]) {
      expect(existsSync(resolve(sourceRoot, legacy))).toBe(false);
    }
    expect(existsSync(resolve(sourceRoot, "config.ts"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "cycle.ts"))).toBe(false);
  });

  it("prevents lower layers from importing workers or higher-level implementation layers", () => {
    const allowed: Record<Layer, ReadonlySet<Layer>> = {
      clients: new Set(["clients"]),
      configuration: new Set(["configuration"]),
      services: new Set(["clients", "services"]),
      storage: new Set(["storage"]),
      workers: new Set(layers),
    };
    const violations: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const sourceLayer = layerOf(file);
      if (!sourceLayer) continue;
      for (const imported of localImports(file)) {
        const targetLayer = layerOf(imported);
        if (targetLayer && !allowed[sourceLayer].has(targetLayer)) {
          violations.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, imported)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps database construction and SQL out of workers and services", () => {
    const violations = sourceFiles(sourceRoot)
      .filter((file) => layerOf(file) !== "storage")
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return /backend-common\/persistence|\.prepare\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\b/iu.test(source)
          ? [relative(sourceRoot, file)]
          : [];
      });

    expect(violations).toEqual([]);
  });

  it("makes each service own a narrow collaborator port", () => {
    const violations = sourceFiles(resolve(sourceRoot, "services"))
      .filter((file) => /store:\s*RenewalStore\b/u.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file));

    expect(violations).toEqual([]);
  });
});
