import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBinary, fetchJson } from "../src/clients/http-client";

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

  it("preserves the final HTTP status without retaining an upstream error body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response("upstream failed", {
        status: 500,
        headers: { "Retry-After": "0" },
      })
    ));

    await expect(fetchJson("https://source.test/data", { timeoutMs: 1_000, retries: 1 }))
      .rejects.toThrow("Request failed after 2 attempts: HTTP 500");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects insecure URLs and never follows JSON redirects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data" },
    }));

    await expect(fetchJson("http://source.test/data", { timeoutMs: 1_000, retries: 2 }))
      .rejects.toThrow("JSON URL is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(fetchJson("https://source.test/data", { timeoutMs: 1_000, retries: 2 }))
      .rejects.toThrow("Request failed after 1 attempts: HTTP 302");
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).redirect).toBe("manual");
  });

  it("rejects invalid JSON without pretending it retried parsing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(fetchJson("https://source.test/data", { timeoutMs: 1_000, retries: 2 }))
      .rejects.toThrow("Response was not valid JSON");
  });

  it("keeps the timeout active while a JSON response body is streaming", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      });
      const signal = input instanceof Request ? input.signal : init?.signal;
      signal?.addEventListener("abort", () => {
        streamController?.error(signal.reason ?? new Error("aborted"));
      }, { once: true });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await expect(fetchJson("https://source.test/data", {
      timeoutMs: 10, retries: 0,
    })).rejects.toThrow("Request failed after 1 attempts: JSON request timed out");
  });

  it("stops reading JSON responses above the configured limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[1,2,3,4]"));

    await expect(fetchJson("https://source.test/data", {
      timeoutMs: 1_000, retries: 0, maxBytes: 3,
    })).rejects.toThrow("Response exceeded 3 bytes");
  });

  it("returns binary content metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png; charset=binary" },
    }));

    const result = await fetchBinary("https://source.test/image", {
      timeoutMs: 1_000, retries: 0, allowedHosts: ["source.test"], maxBytes: 10,
    });

    expect([...result.body]).toEqual([1, 2, 3]);
    expect(result.contentType).toBe("image/png");
  });

  it("rejects disallowed media hosts and cross-host redirects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://metadata.internal/image" },
    }));

    await expect(fetchBinary("https://untrusted.test/image", {
      timeoutMs: 1_000, retries: 0, allowedHosts: ["source.test"],
    })).rejects.toThrow("Binary URL is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(fetchBinary("https://source.test/image", {
      timeoutMs: 1_000, retries: 0, allowedHosts: ["source.test"],
    })).rejects.toThrow("Binary URL is not allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops reading binary responses above the configured limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));

    await expect(fetchBinary("https://source.test/image", {
      timeoutMs: 1_000, retries: 0, allowedHosts: ["source.test"], maxBytes: 3,
    })).rejects.toThrow("Response exceeded 3 bytes");
  });

  it("keeps the timeout active while the response body is streaming", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      });
      const signal = _input instanceof Request ? _input.signal : init?.signal;
      signal?.addEventListener("abort", () => {
        streamController?.error(signal.reason ?? new Error("aborted"));
      }, { once: true });
      return new Response(body, { status: 200, headers: { "Content-Type": "image/png" } });
    });

    await expect(fetchBinary("https://source.test/image", {
      timeoutMs: 10, retries: 0, allowedHosts: ["source.test"], maxBytes: 10,
    })).rejects.toThrow();
  });

  it("cancels redirect bodies before following the next allowed hop", async () => {
    const cancel = vi.fn();
    const redirectedBody = new ReadableStream<Uint8Array>({ cancel });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(redirectedBody, {
        status: 302, headers: { Location: "https://source.test/final" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));

    const response = await fetchBinary("https://source.test/image", {
      timeoutMs: 1_000, retries: 0, allowedHosts: ["source.test"], maxBytes: 10,
    });
    expect([...response.body]).toEqual([1]);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
