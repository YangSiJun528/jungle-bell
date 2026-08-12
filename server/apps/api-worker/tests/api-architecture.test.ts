import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const layers = ["controllers", "domain", "services", "storage"] as const;
type Layer = typeof layers[number];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function localImports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu)]
    .map((match) => resolve(dirname(file), match[1] ?? ""));
}

function layerOf(path: string): Layer | null {
  const first = relative(sourceRoot, path).split(sep)[0];
  return layers.find((layer) => layer === first) ?? null;
}

describe("API Worker architecture", () => {
  it("keeps HTTP, business logic, and persistence in explicit layers", () => {
    for (const layer of layers) expect(existsSync(resolve(sourceRoot, layer))).toBe(true);
    for (const legacy of ["adapters", "application", "collection", "http", "renewal", "use-cases"]) {
      expect(existsSync(resolve(sourceRoot, legacy))).toBe(false);
    }
  });

  it("prevents lower layers from depending on controllers", () => {
    const allowed: Record<Layer, ReadonlySet<Layer>> = {
      controllers: new Set(["controllers", "domain", "services"]),
      domain: new Set(["domain"]),
      services: new Set(["domain", "services", "storage"]),
      storage: new Set(["storage"]),
    };
    const violations: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const sourceLayer = layerOf(file);
      if (!sourceLayer) continue;
      for (const imported of localImports(file)) {
        const targetLayer = layerOf(imported);
        const isCompositionImport = relative(sourceRoot, file) === "controllers/middleware.ts"
          && targetLayer === "storage";
        if (targetLayer && !allowed[sourceLayer].has(targetLayer) && !isCompositionImport) {
          violations.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, imported)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps Hono out of services, domain, and storage", () => {
    const violations = sourceFiles(sourceRoot)
      .filter((file) => {
        const layer = layerOf(file);
        return layer !== null && layer !== "controllers";
      })
      .filter((file) => /\bfrom\s+["'](?:@hono\/|hono(?:\/|["']))/u.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file));

    expect(violations).toEqual([]);
  });

  it("keeps D1 queries inside storage and construction inside the composition root", () => {
    const databaseCalls = sourceFiles(sourceRoot)
      .filter((file) => layerOf(file) !== "storage")
      .filter((file) => /\.prepare\s*\(/u.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file));
    const persistenceConstruction = sourceFiles(sourceRoot)
      .filter((file) => readFileSync(file, "utf8").includes("new D1RenewalStore"))
      .map((file) => relative(sourceRoot, file));

    expect(databaseCalls).toEqual([]);
    expect(persistenceConstruction).toEqual(["controllers/middleware.ts"]);
  });

  it("makes each service own a narrow collaborator port", () => {
    const violations = sourceFiles(resolve(sourceRoot, "services"))
      .filter((file) => /(?:store|storage):\s*(?:RenewalStore|CloudflareApiStorage)\b/u.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file));

    expect(violations).toEqual([]);
  });
});
