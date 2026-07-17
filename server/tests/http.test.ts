import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBinary, fetchJson } from "../src/http";

afterEach(() => vi.restoreAllMocks());

describe("collector HTTP client", () => {
  it("retries retryable HTTP failures with Ky", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporarily unavailable", {
        status: 503,
        headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const result = await fetchJson("https://source.test/data", { timeoutMs: 1_000, retries: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.raw).toBe('{"ok":true}');
    expect(result.value).toEqual({ ok: true });
  });

  it("preserves useful final HTTP error details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream failed", { status: 500 }));

    await expect(fetchJson("https://source.test/data", { timeoutMs: 1_000, retries: 0 }))
      .rejects.toThrow("Request failed after 1 attempts: HTTP 500: upstream failed");
  });

  it("rejects invalid JSON without pretending it retried parsing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(fetchJson("https://source.test/data", { timeoutMs: 1_000, retries: 2 }))
      .rejects.toThrow("Response was not valid JSON");
  });

  it("returns binary content metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png; charset=binary" },
    }));

    const result = await fetchBinary("https://source.test/image", { timeoutMs: 1_000, retries: 0 });

    expect([...result.body]).toEqual([1, 2, 3]);
    expect(result.contentType).toBe("image/png");
  });
});
