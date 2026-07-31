import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const API_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const WEB_CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; media-src 'none'; worker-src 'self'; manifest-src 'self'";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("server-delivered security policy", () => {
  it("marks every API response no-store while preserving the API-only CSP", async () => {
    const directory = await webRoot();
    const app = await buildApp({
      allowDevBootstrap: false,
      webRoot: directory,
    });

    for (const request of [
      { method: "GET" as const, url: "/api/health" },
      { method: "GET" as const, url: "/api/ready" },
      { method: "GET" as const, url: "/api/private/dashboard" },
      {
        method: "GET" as const,
        url: "/api/private/desktop/dashboard",
      },
      { method: "GET" as const, url: "/api/not-found" },
    ]) {
      const response = await app.inject(request);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBe(API_CSP);
    }

    await app.close();
  });

  it("serves both index HTML and SPA fallbacks with the remote Tauri web CSP", async () => {
    const directory = await webRoot();
    const app = await buildApp({ webRoot: directory });

    for (const url of ["/", "/attendance/deep-link"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<div id="root"></div>');
      expect(response.headers["content-security-policy"]).toBe(WEB_CSP);
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    await app.close();
  });
});

async function webRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jungle-bell-web-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><body><div id="root"></div></body></html>',
    "utf8",
  );
  return directory;
}
