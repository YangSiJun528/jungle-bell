import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./fetch-with-timeout";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("aborts a stalled request and exposes a stable timeout code", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const request = fetchWithTimeout("/api/stalled", {}, 50);
    const assertion = expect(request).rejects.toThrow("REQUEST_TIMEOUT");
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });

  it("forwards a caller abort without rewriting it as a timeout", async () => {
    const caller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("caller aborted", "AbortError"));
          });
        }),
    );

    const request = fetchWithTimeout(
      "/api/cancelled",
      { signal: caller.signal },
      1_000,
    );
    caller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("clears the timer after a successful response", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(
      fetchWithTimeout("/api/ok", {}, 1_000),
    ).resolves.toMatchObject({ status: 204 });
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
