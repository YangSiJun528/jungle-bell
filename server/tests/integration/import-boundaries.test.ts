import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const serverRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(serverRoot, "..");
const sharedRoot = join(serverRoot, "shared");
const apiRoot = join(serverRoot, "apps/api-worker");
const jobsRoot = join(serverRoot, "apps/jobs-runner");

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function resolvedImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return ts.preProcessFile(source).importedFiles
    .map(({ fileName }) => fileName)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => normalize(resolve(dirname(file), specifier)));
}

function moduleSpecifiers(file: string): string[] {
  return ts.preProcessFile(readFileSync(file, "utf8")).importedFiles.map(({ fileName }) => fileName);
}

function expectNoImports(sourceRoot: string, forbiddenRoot: string): void {
  for (const file of sourceFiles(sourceRoot)) {
    for (const imported of resolvedImports(file)) {
      expect(isWithin(imported, forbiddenRoot), `${relative(serverRoot, file)} imports ${relative(serverRoot, imported)}`).toBe(false);
    }
  }
}

describe("server source boundaries", () => {
  it("keeps deployable applications and shared code in explicit roots", () => {
    expect(existsSync(join(serverRoot, "src"))).toBe(false);
    expect(sourceFiles(join(apiRoot, "src")).length).toBeGreaterThan(0);
    expect(sourceFiles(join(jobsRoot, "src")).length).toBeGreaterThan(0);
    expect(sourceFiles(sharedRoot).length).toBeGreaterThan(0);
  });

  it("prevents shared code from depending on either application", () => {
    expectNoImports(sharedRoot, apiRoot);
    expectNoImports(sharedRoot, jobsRoot);
  });

  it("prevents the two deployable applications from importing each other", () => {
    expectNoImports(apiRoot, jobsRoot);
    expectNoImports(jobsRoot, apiRoot);
    for (const file of sourceFiles(apiRoot)) {
      expect(moduleSpecifiers(file)).not.toContainEqual(expect.stringMatching(/^@jungle-bell\/jobs-runner(?:\/|$)/u));
    }
    for (const file of sourceFiles(jobsRoot)) {
      expect(moduleSpecifiers(file)).not.toContainEqual(expect.stringMatching(/^@jungle-bell\/api-worker(?:\/|$)/u));
    }
  });

  it("does not allow path aliases to bypass the relative-import boundary checks", () => {
    for (const fileName of [
      "tsconfig.base.json",
      "tsconfig.shared.json",
      "tsconfig.api-worker.json",
      "tsconfig.jobs-runner.json",
      "tsconfig.tests.json",
    ]) {
      const config = JSON.parse(readFileSync(join(serverRoot, fileName), "utf8")) as {
        compilerOptions?: { baseUrl?: unknown; paths?: unknown };
      };
      expect(config.compilerOptions).not.toHaveProperty("baseUrl");
      expect(config.compilerOptions).not.toHaveProperty("paths");
    }
  });

  it("keeps the Jobs runtime on Node types without browser DOM globals", () => {
    const config = JSON.parse(readFileSync(join(serverRoot, "tsconfig.jobs-runner.json"), "utf8")) as {
      compilerOptions?: { lib?: string[]; types?: string[] };
    };

    expect(config.compilerOptions?.lib).toEqual(["ES2023"]);
    expect(config.compilerOptions?.types).toEqual(["node"]);
  });

  it("exposes frontend contracts from shared instead of an application", () => {
    const personalApi = readFileSync(join(repositoryRoot, "src/api/personal-api.ts"), "utf8");
    expect(personalApi).toContain("@jungle-bell/backend-common/contracts/personal");
    expect(personalApi).not.toMatch(/hono(?:\/client)?|server\/(?:apps|shared|src)\//u);
  });

  it("owns runtime dependencies in common, API, and Jobs packages", () => {
    const frontendPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const serverPackage = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as {
      workspaces: string[];
      dependencies?: Record<string, string>;
    };
    const commonPackage = JSON.parse(readFileSync(join(sharedRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const apiPackage = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const jobsPackage = JSON.parse(readFileSync(join(jobsRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(serverPackage.workspaces).toEqual(["shared", "apps/api-worker", "apps/jobs-runner"]);
    expect(serverPackage.dependencies).toBeUndefined();
    expect(frontendPackage.dependencies["@jungle-bell/backend-common"]).toBe("file:server/shared");
    expect(frontendPackage.dependencies).not.toHaveProperty("hono");
    expect(frontendPackage.dependencies).not.toHaveProperty("@hono/zod-validator");

    expect(Object.keys(commonPackage.dependencies).sort()).toEqual([
      "@logtape/logtape", "json-canonicalize", "zod",
    ]);
    expect(apiPackage.dependencies).toMatchObject({
      "@jungle-bell/backend-common": "0.1.0",
      "@hono/zod-validator": expect.any(String),
      hono: expect.any(String),
    });
    expect(apiPackage.dependencies).not.toHaveProperty("commander");
    expect(apiPackage.dependencies).not.toHaveProperty("ky");
    expect(apiPackage.dependencies).not.toHaveProperty("web-push");
    expect(jobsPackage.dependencies).toMatchObject({
      "@jungle-bell/backend-common": "0.1.0",
      commander: expect.any(String),
      ky: expect.any(String),
      "web-push": expect.any(String),
    });
    expect(jobsPackage.dependencies).not.toHaveProperty("hono");
    expect(jobsPackage.dependencies).not.toHaveProperty("@hono/zod-validator");
  });

  it("keeps Hono at the API controller boundary and storage behind services", () => {
    const apiSource = join(apiRoot, "src");
    const controllers = join(apiSource, "controllers");
    const services = join(apiSource, "services");
    const storage = join(apiSource, "storage");

    expect(existsSync(join(apiSource, "http"))).toBe(false);
    expect(existsSync(join(apiSource, "use-cases"))).toBe(false);
    expect(existsSync(join(apiSource, "adapters"))).toBe(false);

    for (const file of [...sourceFiles(services), ...sourceFiles(storage)]) {
      expect(moduleSpecifiers(file), relative(serverRoot, file)).not.toContainEqual(
        expect.stringMatching(/^(?:@hono\/|hono(?:\/|$))/u),
      );
    }
    for (const file of sourceFiles(controllers)) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(serverRoot, file)).not.toMatch(/context\.var\.(?:renewalStore|storage)/u);
    }
  });
});
