import { describe, expect, it, vi } from "vitest";

import {
  LmsGatewayError,
  LmsHttpGateway,
} from "./gateway.js";
import type { LmsCookie } from "./session-vault.js";

const accessCookie: LmsCookie = {
  name: "access_token",
  value: "fresh.access.jwt",
  domain: "jungle-lms.krafton.com",
  path: "/",
  expires: 1_900_000_000,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
};

describe("LmsHttpGateway identity verification", () => {
  it("sends only one access cookie in exactly one GET /api/v2/me request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        200,
        [
          "access_token=server.rotation.is.discarded; Path=/; Secure; HttpOnly",
          "refresh_token=must.never.be.consumed; Path=/; Secure; HttpOnly",
        ],
        { id: "lms-user-1" },
      ),
    );

    const result = await new LmsHttpGateway(fetcher).verifyIdentity([
      accessCookie,
    ]);

    expect(result).toEqual({
      authenticated: true,
      subject: "lms-user-1",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://jungle-lms.krafton.com/api/v2/me",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    const sent = (
      fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>
    ).cookie;
    expect(sent).toBe("access_token=fresh.access.jwt");
    expect(sent).not.toContain("refresh_token");
  });

  it("rejects 401 after that one ordinary request without any refresh call or retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(401));

    await expect(
      new LmsHttpGateway(fetcher).verifyIdentity([accessCookie]),
    ).resolves.toEqual({ authenticated: false, subject: null });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://jungle-lms.krafton.com/api/v2/me",
    ]);
  });

  it("rejects refresh-only or multi-cookie input before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new LmsHttpGateway(fetcher);
    const refreshCookie = {
      ...accessCookie,
      name: "refresh_token",
    };

    await expect(
      gateway.verifyIdentity([refreshCookie]),
    ).rejects.toMatchObject({ code: "LMS_ACCESS_COOKIE_REQUIRED" });
    await expect(
      gateway.verifyIdentity([accessCookie, refreshCookie]),
    ).rejects.toMatchObject({ code: "LMS_ACCESS_COOKIE_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: "immutable-42" }, "immutable-42"],
    [{ id: 42 }, "42"],
    [
      {
        email: "user@example.com",
        userId: "mutable-alias",
        user_id: "legacy-alias",
      },
      null,
    ],
    [{ id: " padded " }, null],
    [{ id: "가".repeat(43) }, null],
    [{ id: -1 }, null],
  ] as const)(
    "uses only the exact immutable id from /api/v2/me",
    async (body, subject) => {
      const result = await new LmsHttpGateway(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(response(200, [], body)),
      ).verifyIdentity([accessCookie]);

      expect(result.authenticated).toBe(true);
      expect(result.subject).toBe(subject);
    },
  );

  it("isolates concurrent users in one gateway instance", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      await Promise.resolve();
      const sent =
        (init?.headers as Record<string, string> | undefined)?.cookie ??
        "";
      const user = sent.includes("user-a") ? "user-a" : "user-b";
      return response(200, [], { id: user });
    });
    const gateway = new LmsHttpGateway(fetcher);

    const [userA, userB] = await Promise.all([
      gateway.verifyIdentity([
        { ...accessCookie, value: "user-a.access" },
      ]),
      gateway.verifyIdentity([
        { ...accessCookie, value: "user-b.access" },
      ]),
    ]);

    expect(userA.subject).toBe("user-a");
    expect(userB.subject).toBe("user-b");
    expect(
      fetcher.mock.calls.map(
        ([, init]) =>
          (init?.headers as Record<string, string>).cookie,
      ),
    ).toEqual(
      expect.arrayContaining([
        "access_token=user-a.access",
        "access_token=user-b.access",
      ]),
    );
  });

  it("accepts a WebView session access cookie represented by expires=-1", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, [], { id: "user-1" }));
    await new LmsHttpGateway(fetcher).verifyIdentity([
      { ...accessCookie, expires: -1 },
    ]);

    expect(
      (fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).cookie,
    ).toBe("access_token=fresh.access.jwt");
  });

  it("does not follow redirects and classifies them as an invalid upstream response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(302));
    const result = new LmsHttpGateway(fetcher).verifyIdentity([
      accessCookie,
    ]);

    await expect(result).rejects.toMatchObject({
      code: "LMS_ME_RESPONSE_INVALID",
      failureKind: "invalid-response",
      status: 302,
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it.each([408, 429, 500, 503])(
    "classifies HTTP %i as transient instead of unauthenticated",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(status));
      await expect(
        new LmsHttpGateway(fetcher).verifyIdentity([accessCookie]),
      ).rejects.toMatchObject({
        code: "LMS_UPSTREAM_STATUS",
        failureKind: "transient",
        status,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("rejects and cancels a non-JSON /me response", async () => {
    const upstream = new Response(JSON.stringify({ id: "user-1" }), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const cancel = vi.spyOn(upstream.body!, "cancel");
    const request = new LmsHttpGateway(
      vi.fn<typeof fetch>().mockResolvedValue(upstream),
    ).verifyIdentity([accessCookie]);

    await expect(request).rejects.toMatchObject({
      code: "LMS_ME_RESPONSE_INVALID",
      failureKind: "invalid-response",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an oversized /me stream before buffering it", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(300 * 1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new LmsHttpGateway(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        }),
      ),
    ).verifyIdentity([accessCookie]);

    await expect(request).rejects.toMatchObject({
      code: "LMS_ME_RESPONSE_INVALID",
      failureKind: "invalid-response",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("allows only an explicitly opted-in loopback HTTP transport for tests", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, [], { id: "user-1" }));
    await new LmsHttpGateway({
      allowTestLoopbackHttp: true,
      fetcher,
      origin: "http://127.0.0.1:43123",
    }).verifyIdentity([accessCookie]);

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/me",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([
    "http://127.0.0.1:43123",
    "http://lms.example.test",
    "https://lms.example.test",
    "https://lms.example.test/path",
    "https://user:lms@example.test",
  ])("rejects a non-exact production transport origin: %s", (origin) => {
    expect(
      () =>
        new LmsHttpGateway({
          fetcher: vi.fn<typeof fetch>(),
          origin,
        }),
    ).toThrow(expect.objectContaining({ code: "LMS_ORIGIN_INVALID" }));
  });

  it("classifies a timeout without retaining the one-shot access cookie", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const request = new LmsHttpGateway(fetcher, 1).verifyIdentity([
      accessCookie,
    ]);

    await expect(request).rejects.toBeInstanceOf(LmsGatewayError);
    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "LMS_UPSTREAM_TIMEOUT",
      failureKind: "transient",
      status: null,
    });
    expect(error).not.toHaveProperty("cookies");
  });
});

function response(
  status: number,
  setCookies: readonly string[] = [],
  body?: unknown,
): Response {
  const headers = new Headers();
  for (const value of setCookies) {
    headers.append("set-cookie", value);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Response(
    body === undefined ? null : JSON.stringify(body),
    { status, headers },
  );
}
