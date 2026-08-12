import { describe, expect, it, vi } from "vitest";
import {
  handleR2Gateway,
  R2_GATEWAY_MAX_BODY_BYTES,
} from "../src/storage/cloudflare/r2-gateway";

const secret = "s".repeat(64);

function request(
  method: string,
  key: string,
  init: { authorization?: string; body?: string | Uint8Array; contentType?: string; contentLength?: string } = {},
): Request {
  const headers = new Headers({ authorization: init.authorization ?? `Bearer ${secret}` });
  if (init.contentType) headers.set("content-type", init.contentType);
  if (init.contentLength) headers.set("content-length", init.contentLength);
  return new Request(`https://api.test/internal/jobs/r2?key=${encodeURIComponent(key)}`, {
    method,
    headers,
    ...(init.body !== undefined ? {
      body: typeof init.body === "string" ? init.body : Uint8Array.from(init.body).buffer,
    } : {}),
  });
}

function object(body: string, contentType = "application/json; charset=utf-8"): R2ObjectBody {
  const bytes = new TextEncoder().encode(body);
  return {
    body: new Response(bytes).body!,
    size: bytes.byteLength,
    httpEtag: '"etag"',
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", contentType),
  } as unknown as R2ObjectBody;
}

function bucket(overrides: Partial<R2Bucket> = {}): R2Bucket {
  return {
    get: vi.fn(async () => null),
    head: vi.fn(async () => null),
    put: vi.fn(async () => null),
    ...overrides,
  } as unknown as R2Bucket;
}

describe("internal R2 gateway", () => {
  it("authenticates before validating a key or touching R2", async () => {
    const dataBucket = bucket();
    const response = await handleR2Gateway(request("GET", "not-allowed/private", {
      authorization: `Bearer ${"x".repeat(64)}`,
    }), { DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret });

    expect(response.status).toBe(401);
    expect(dataBucket.get).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("streams an allowlisted JSON object through the fixed DATA_BUCKET binding", async () => {
    const put = vi.fn(async (_key: string, body: unknown, options?: R2PutOptions) => {
      const received = await new Response(body as BodyInit).text();
      expect(received).toBe('{"ok":true}');
      expect(options).toMatchObject({ httpMetadata: { contentType: "application/json; charset=utf-8" } });
      return {} as R2Object;
    });
    const dataBucket = bucket({ put: put as unknown as R2Bucket["put"] });
    const body = '{"ok":true}';
    const response = await handleR2Gateway(request("PUT", "latest/laundry.json", {
      body,
      contentType: "application/json; charset=utf-8",
      contentLength: String(new TextEncoder().encode(body).byteLength),
    }), { DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret });

    expect(response.status).toBe(204);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe("latest/laundry.json");
  });

  it("streams GET and serves HEAD metadata with defensive headers", async () => {
    const stored = object('{"ok":true}');
    const dataBucket = bucket({
      get: vi.fn(async () => stored),
      head: vi.fn(async () => stored),
    });

    const get = await handleR2Gateway(request("GET", "collector/state/laundry.json"), {
      DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret,
    });
    const head = await handleR2Gateway(request("HEAD", "collector/state/laundry.json"), {
      DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret,
    });

    expect(get.status).toBe(200);
    expect(await get.text()).toBe('{"ok":true}');
    expect(get.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("etag")).toBe('"etag"');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(new TextEncoder().encode('{"ok":true}').byteLength));
  });

  it.each([
    "private/object.json",
    "raw/../secret.json",
    "raw//laundry.json",
    "raw/%escaped.json",
  ])("rejects a key outside the strict Jobs prefix surface: %s", async (key) => {
    const dataBucket = bucket();
    const response = await handleR2Gateway(request("GET", key), {
      DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret,
    });
    expect(response.status).toBe(400);
    expect(dataBucket.get).not.toHaveBeenCalled();
  });

  it("allows only JSON outside assets and raster media inside assets", async () => {
    const dataBucket = bucket();
    const jsonAsImage = await handleR2Gateway(request("PUT", "latest/meals.json", {
      body: "x", contentType: "image/png", contentLength: "1",
    }), { DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret });
    const assetAsJson = await handleR2Gateway(request("PUT", `assets/${"a".repeat(64)}.jpg`, {
      body: "x", contentType: "application/json", contentLength: "1",
    }), { DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret });

    expect(jsonAsImage.status).toBe(415);
    expect(assetAsJson.status).toBe(415);
    expect(dataBucket.put).not.toHaveBeenCalled();
  });

  it("requires a declared streaming length and enforces the 16 MiB ceiling", async () => {
    const dataBucket = bucket();
    const missing = await handleR2Gateway(request("PUT", "latest/meals.json", {
      body: "{}", contentType: "application/json",
    }), { DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret });
    const oversized = await handleR2Gateway(request("PUT", "latest/meals.json", {
      body: "{}", contentType: "application/json",
      contentLength: String(R2_GATEWAY_MAX_BODY_BYTES + 1),
    }), { DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret });

    expect(missing.status).toBe(411);
    expect(oversized.status).toBe(413);
    expect(dataBucket.put).not.toHaveBeenCalled();
  });

  it("fails closed when not configured and maps binding failures without details", async () => {
    const dataBucket = bucket({ get: vi.fn(async () => { throw new Error("private bucket error"); }) });
    const unconfigured = await handleR2Gateway(request("GET", "latest/meals.json"), {
      DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: "short",
    });
    const failed = await handleR2Gateway(request("GET", "latest/meals.json"), {
      DATA_BUCKET: dataBucket, JOBS_D1_GATEWAY_SECRET: secret,
    });

    expect(unconfigured.status).toBe(503);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe('{"error":"R2_OPERATION_FAILED"}');
  });
});
