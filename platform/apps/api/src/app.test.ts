import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { computeLmsSubjectBinding } from "./lms/subject-binding.js";
import { Sha256Hasher } from "./infra/crypto.js";
import {
  InMemoryAttendanceSnapshotStore,
  InMemoryDesktopIdentityStore,
} from "./infra/sqlite/index.js";
import type { LmsCookie } from "./lms/session-vault.js";

const LOOPBACK_ORIGIN = "http://127.0.0.1:5173";
const LMS_COOKIES = [
  {
    name: "access_token",
    value: "header.payload.signature",
    domain: "jungle-lms.krafton.com",
    path: "/",
    expires: 1_900_000_000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  },
] as const;

function cookiePair(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toEqual(expect.any(String));
  return value!.split(";", 1)[0]!;
}

function mutationHeaders(cookie?: string, origin = LOOPBACK_ORIGIN) {
  return {
    origin,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function identityHash(subject: string): Promise<string> {
  return new Sha256Hasher().hash(`test-identity:${subject}`);
}

async function onboard(
  app: Awaited<ReturnType<typeof buildApp>>,
  desktopDeviceId: string,
  priorCookie?: string,
  subject = "immutable-lms-id-42",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/onboarding/lms-identity",
    ...(priorCookie === undefined
      ? {}
      : { headers: { cookie: priorCookie } }),
    payload: {
      desktopDeviceId,
      subjectBinding: computeLmsSubjectBinding(
        desktopDeviceId,
        subject,
      ),
      cookies: LMS_COOKIES,
    },
  });
  return {
    response,
    cookie:
      response.headers["set-cookie"] === undefined
        ? null
        : cookiePair(response.headers["set-cookie"]),
  };
}

async function bootstrapDesktop(
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/dev/desktop-session",
  });
  expect(response.statusCode).toBe(204);
  return cookiePair(response.headers["set-cookie"]);
}

async function pairMobile(
  app: Awaited<ReturnType<typeof buildApp>>,
  desktopCookie: string,
): Promise<string> {
  const pairingResponse = await app.inject({
    method: "POST",
    url: "/api/pairings",
    headers: mutationHeaders(desktopCookie),
  });
  expect(pairingResponse.statusCode).toBe(201);
  const pairing = pairingResponse.json<{
    pairingId: string;
    qrPayload: string;
  }>();
  const challenge = new URLSearchParams(
    new URL(pairing.qrPayload).hash.slice(1),
  ).get("challenge");
  const claimResponse = await app.inject({
    method: "POST",
    url: `/api/pairings/${pairing.pairingId}/claims`,
    headers: mutationHeaders(),
    payload: {
      challenge,
      deviceLabel: "Test phone",
      installationId: `jbmi_${"1".repeat(32)}`,
    },
  });
  expect(claimResponse.statusCode).toBe(201);
  const claim = claimResponse.json<{
    claimId: string;
    claimReceipt: string;
  }>();
  const claimedStatus = await app.inject({
    method: "GET",
    url: `/api/pairings/${pairing.pairingId}`,
    headers: { cookie: desktopCookie },
  });
  expect(claimedStatus.statusCode).toBe(200);
  expect(claimedStatus.json()).toEqual({
    status: "claimed",
    claim: {
      claimId: pairing.pairingId,
      deviceLabel: "Test phone",
      confirmationCode: "1111",
    },
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/pairings/${pairing.pairingId}/approve`,
        headers: mutationHeaders(desktopCookie),
        payload: { claimId: claim.claimId },
      })
    ).statusCode,
  ).toBe(204);
  const complete = await app.inject({
    method: "POST",
    url: `/api/pairings/${pairing.pairingId}/complete`,
    headers: mutationHeaders(),
    payload: {
      claimId: claim.claimId,
      claimReceipt: claim.claimReceipt,
    },
  });
  expect(complete.statusCode).toBe(204);
  return cookiePair(complete.headers["set-cookie"]);
}

function verifiedGateway(subject: () => string | null) {
  return {
    verifyIdentity: vi.fn(async (_cookies: readonly LmsCookie[]) => ({
      authenticated: true,
      subject: subject(),
    })),
  };
}

describe("platform API boundaries", () => {
  it("separates process liveness from dependency readiness", async () => {
    const ready = await buildApp({ readinessCheck: async () => true });
    expect(
      (
        await ready.inject({ method: "GET", url: "/api/health" })
      ).json(),
    ).toEqual({ status: "ok" });
    expect(
      (
        await ready.inject({ method: "GET", url: "/api/ready" })
      ).json(),
    ).toEqual({ status: "ready" });
    await ready.close();

    for (const readinessCheck of [
      async () => false,
      async () => {
        throw new Error("database unavailable");
      },
    ]) {
      const unavailable = await buildApp({ readinessCheck });
      const response = await unavailable.inject({
        method: "GET",
        url: "/api/ready",
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "unavailable" });
      await unavailable.close();
    }
  });

  it("keeps public campus data public and user data private", async () => {
    const app = await buildApp({ allowDevBootstrap: true });
    const laundry = await app.inject({
      method: "GET",
      url: "/api/public/campus/laundry",
    });
    expect(laundry.statusCode).toBe(200);
    expect(laundry.json()).toEqual({
      kind: "laundry",
      data: null,
      etag: null,
      savedAtEpochMs: null,
      lastCheckedAtEpochMs: null,
      stale: true,
      lastError: "CAMPUS_COLLECTOR_NOT_CONFIGURED",
    });
    expect(laundry.headers["cache-control"]).toBe("no-store");

    const obsolete = await app.inject({
      method: "GET",
      url: "/api/public/snapshot",
    });
    expect(obsolete.statusCode).toBe(404);

    const privateResponse = await app.inject({
      method: "GET",
      url: "/api/private/dashboard",
    });
    expect(privateResponse.statusCode).toBe(401);
    await app.close();
  });

  it("requires exact browser Origin while allowing only explicit native mutations without Origin", async () => {
    const publicOrigin = "https://bell.example.com";
    const app = await buildApp({
      allowDevBootstrap: true,
      publicOrigin,
    });
    const desktopCookie = await bootstrapDesktop(app);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/pairings",
      headers: mutationHeaders(desktopCookie, "https://evil.example.com"),
    });
    expect(wrong.statusCode).toBe(403);

    const missingBrowserOrigin = await app.inject({
      method: "POST",
      url: "/api/pairings",
      headers: { cookie: desktopCookie },
    });
    expect(missingBrowserOrigin.statusCode).toBe(403);

    const malformedEmptyJson = await app.inject({
      method: "POST",
      url: "/api/pairings",
      headers: {
        ...mutationHeaders(desktopCookie, publicOrigin),
        "content-type": "application/json",
      },
    });
    expect(malformedEmptyJson.statusCode).toBe(400);
    expect(malformedEmptyJson.json()).toEqual({
      error: "INVALID_REQUEST",
    });

    const nativeHeartbeat = await app.inject({
      method: "POST",
      url: "/api/private/desktop/heartbeat",
      headers: { cookie: desktopCookie },
      payload: { lmsSessionState: "connected", appVersion: "0.2.0" },
    });
    expect(nativeHeartbeat.statusCode).toBe(200);
    await app.close();
  });

  it("finds the same internal user from the verified LMS identity on every PC", async () => {
    let subject: string | null = "immutable-lms-id-42";
    const gateway = verifiedGateway(() => subject);
    const identities = new InMemoryDesktopIdentityStore();
    const app = await buildApp({
      lmsGateway: gateway,
      lmsSubjectToIdentityHash: identityHash,
      desktopIdentityStore: identities,
      publicOrigin: "https://bell.example.com",
    });

    const first = await onboard(app, "desktop-installation-a");
    const second = await onboard(app, "desktop-installation-b");
    expect(first.response.statusCode).toBe(204);
    expect(second.response.statusCode).toBe(204);

    const firstStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: first.cookie! },
    });
    const secondStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: second.cookie! },
    });
    expect(firstStatus.json().user.id).toBe(secondStatus.json().user.id);
    expect(firstStatus.json().desktop.id).toBe("desktop-installation-a");
    expect(secondStatus.json().desktop.id).toBe("desktop-installation-b");
    expect(await identities.listDesktopDevices(firstStatus.json().user.id))
      .toHaveLength(2);

    subject = "different-lms-id";
    const switched = await onboard(
      app,
      "desktop-installation-a",
      first.cookie!,
      "different-lms-id",
    );
    expect(switched.response.statusCode).toBe(204);
    const oldSession = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: first.cookie! },
    });
    expect(oldSession.statusCode).toBe(401);
    const switchedStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: switched.cookie! },
    });
    expect(switchedStatus.json().user.id).not.toBe(
      secondStatus.json().user.id,
    );
    await app.close();
  });

  it("allows two desktop registrations for each of 200 users behind one NAT", async () => {
    let subject = "lms-user-0";
    const app = await buildApp({
      lmsGateway: verifiedGateway(() => subject),
      lmsSubjectToIdentityHash: identityHash,
    });
    const statuses: number[] = [];
    for (let user = 0; user < 200; user += 1) {
      subject = `lms-user-${user}`;
      for (let pc = 0; pc < 2; pc += 1) {
        const result = await onboard(
          app,
          `desktop-installation-${user}-${pc}`,
          undefined,
          subject,
        );
        statuses.push(result.response.statusCode);
      }
    }

    expect(new Set(statuses)).toEqual(new Set([204]));
    await app.close();
  }, 15_000);

  it("rejects a desktop report whose LMS subject differs from the server-verified identity", async () => {
    const identities = new InMemoryDesktopIdentityStore();
    const registerIdentity = vi.spyOn(
      identities,
      "registerVerifiedIdentity",
    );
    const app = await buildApp({
      lmsGateway: verifiedGateway(() => "immutable-lms-id-42"),
      lmsSubjectToIdentityHash: identityHash,
      desktopIdentityStore: identities,
    });
    const desktopDeviceId = "desktop-installation-a";
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/lms-identity",
      payload: {
        desktopDeviceId,
        subjectBinding: computeLmsSubjectBinding(
          desktopDeviceId,
          "different-lms-id",
        ),
        cookies: LMS_COOKIES,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "LMS_SUBJECT_BINDING_MISMATCH",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(registerIdentity).not.toHaveBeenCalled();
    await app.close();
  });

  it("rotates the app session when the same PC verifies the same LMS account again", async () => {
    const app = await buildApp({
      lmsGateway: verifiedGateway(() => "immutable-lms-id-42"),
      lmsSubjectToIdentityHash: identityHash,
    });
    const first = await onboard(app, "desktop-installation-a");
    const second = await onboard(app, "desktop-installation-a");

    expect(first.response.statusCode).toBe(204);
    expect(second.response.statusCode).toBe(204);
    expect(second.cookie).not.toBe(first.cookie);
    const oldStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: first.cookie! },
    });
    const newStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: second.cookie! },
    });
    expect(oldStatus.statusCode).toBe(401);
    expect(newStatus.statusCode).toBe(200);
    expect(newStatus.json().desktop.id).toBe("desktop-installation-a");
    await app.close();
  });

  it("rotates repeated development desktop sessions", async () => {
    const app = await buildApp({ allowDevBootstrap: true });
    const first = await bootstrapDesktop(app);
    const second = await bootstrapDesktop(app);

    expect(second).not.toBe(first);
    const oldStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: first },
    });
    const newStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: second },
    });
    expect(oldStatus.statusCode).toBe(401);
    expect(newStatus.statusCode).toBe(200);
    await app.close();
  });

  it("rejects LMS responses without the immutable id and never issues a cookie", async () => {
    const app = await buildApp({
      lmsGateway: verifiedGateway(() => null),
      lmsSubjectToIdentityHash: identityHash,
    });
    const result = await onboard(app, "desktop-installation-a");
    expect(result.response.statusCode).toBe(502);
    expect(result.response.json()).toEqual({
      error: "LMS_IDENTITY_UNAVAILABLE",
    });
    expect(result.response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("accepts only one access_token and never forwards a refresh cookie", async () => {
    const gateway = verifiedGateway(() => "immutable-lms-id-42");
    const app = await buildApp({ lmsGateway: gateway });
    const accepted = await onboard(app, "desktop-installation-a");
    expect(accepted.response.statusCode).toBe(204);
    expect(gateway.verifyIdentity).toHaveBeenCalledWith([
      expect.objectContaining({ name: "access_token" }),
    ]);
    expect(
      gateway.verifyIdentity.mock.calls.flatMap(([cookies]) =>
        cookies.map(({ name }) => name),
      ),
    ).not.toContain("refresh_token");

    const refreshOnly = await app.inject({
      method: "POST",
      url: "/api/onboarding/lms-identity",
      payload: {
        desktopDeviceId: "desktop-installation-b",
        subjectBinding: computeLmsSubjectBinding(
          "desktop-installation-b",
          "immutable-lms-id-42",
        ),
        cookies: [
          {
            ...LMS_COOKIES[0],
            name: "refresh_token",
          },
        ],
      },
    });
    expect(refreshOnly.statusCode).toBe(400);
    expect(refreshOnly.json()).toEqual({
      error: "LMS_ACCESS_COOKIE_REQUIRED",
    });

    const multiple = await app.inject({
      method: "POST",
      url: "/api/onboarding/lms-identity",
      payload: {
        desktopDeviceId: "desktop-installation-c",
        subjectBinding: computeLmsSubjectBinding(
          "desktop-installation-c",
          "immutable-lms-id-42",
        ),
        cookies: [
          LMS_COOKIES[0],
          { ...LMS_COOKIES[0], name: "refresh_token" },
        ],
      },
    });
    expect(multiple.statusCode).toBe(400);
    expect(gateway.verifyIdentity).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not issue an app session when LMS authentication is rejected", async () => {
    const app = await buildApp({
      lmsGateway: {
        verifyIdentity: async () => ({
          authenticated: false,
          subject: null,
        }),
      },
    });
    const result = await onboard(app, "desktop-installation-a");
    expect(result.response.statusCode).toBe(401);
    expect(result.response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("does not let fabricated session cookies bypass the shared unauthenticated rate limit", async () => {
    const app = await buildApp();
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await app.inject({
          method: "PUT",
          url: "/api/push/subscriptions",
          headers: {
            ...mutationHeaders(
              `jb_device=jbs_${index.toString(16).padStart(64, "0")}`,
            ),
          },
          payload: {
            endpoint:
              `https://fcm.googleapis.com/fcm/send/fabricated-${index}`,
            expirationTime: null,
            keys: {
              auth: "a".repeat(24),
              p256dh: "b".repeat(48),
            },
          },
        }),
      );
    }

    expect(responses.slice(0, 10).map(({ statusCode }) => statusCode))
      .toEqual(Array.from({ length: 10 }, () => 401));
    expect(responses[10]?.statusCode).toBe(429);
    await app.close();
  });

  it("stores desktop heartbeats and accepts only the newest attendance snapshot", async () => {
    const identities = new InMemoryDesktopIdentityStore();
    const attendance = new InMemoryAttendanceSnapshotStore();
    const app = await buildApp({
      lmsGateway: verifiedGateway(() => "immutable-lms-id-42"),
      lmsSubjectToIdentityHash: identityHash,
      desktopIdentityStore: identities,
      attendanceSnapshotStore: attendance,
    });
    const login = await onboard(app, "desktop-installation-a");
    const desktopCookie = login.cookie!;

    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/private/desktop/heartbeat",
      headers: { cookie: desktopCookie },
      payload: {
        lmsSessionState: "connected",
        appVersion: "0.2.0",
      },
    });
    expect(heartbeat.statusCode).toBe(200);

    const newestAt = new Date(Date.now() - 1_000).toISOString();
    const newest = await app.inject({
      method: "POST",
      url: "/api/private/desktop/attendance-snapshot",
      headers: { cookie: desktopCookie },
      payload: attendancePayload(newestAt, true),
    });
    expect(newest.statusCode).toBe(200);
    expect(newest.json()).toMatchObject({
      accepted: true,
      attendance: {
        status: "available",
        freshness: "fresh",
        snapshot: {
          morningChecked: true,
          sourceDeviceId: "desktop-installation-a",
        },
      },
    });

    const stale = await app.inject({
      method: "POST",
      url: "/api/private/desktop/attendance-snapshot",
      headers: { cookie: desktopCookie },
      payload: attendancePayload(
        new Date(Date.parse(newestAt) - 60_000).toISOString(),
        false,
      ),
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({
      accepted: false,
      attendance: {
        snapshot: { morningChecked: true },
      },
    });

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/private/desktop/dashboard",
      headers: { cookie: desktopCookie },
    });
    expect(dashboard.json()).toMatchObject({
      devices: [
        {
          id: "desktop-installation-a",
          health: "online",
          lmsSessionState: "connected",
          appVersion: "0.2.0",
        },
      ],
      attendance: {
        snapshot: { collectedAt: newestAt },
      },
    });
    await app.close();
  });

  it("keeps a failed login-required heartbeat retriable in memory", async () => {
    const identities = new InMemoryDesktopIdentityStore();
    let failRecording = true;
    const record = vi.fn(() => {
      if (failRecording) {
        throw new Error("notification storage unavailable");
      }
    });
    const app = await buildApp({
      lmsGateway: verifiedGateway(() => "immutable-lms-id-42"),
      lmsSubjectToIdentityHash: identityHash,
      desktopIdentityStore: identities,
      notificationEventSink: { record },
    });
    const login = await onboard(app, "desktop-installation-a");
    const cookie = login.cookie!;
    const userId = (
      await app.inject({
        method: "GET",
        url: "/api/private/desktop/status",
        headers: { cookie },
      })
    ).json().user.id as string;

    const failed = await app.inject({
      method: "POST",
      url: "/api/private/desktop/heartbeat",
      headers: { cookie },
      payload: {
        lmsSessionState: "login-required",
        appVersion: "0.2.0",
      },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({
      error: "HEARTBEAT_PERSISTENCE_UNAVAILABLE",
    });
    const [afterFailure] = await identities.listDesktopDevices(
      userId,
    );
    expect(afterFailure?.lmsSessionState).toBe("connected");

    failRecording = false;
    const retried = await app.inject({
      method: "POST",
      url: "/api/private/desktop/heartbeat",
      headers: { cookie },
      payload: {
        lmsSessionState: "login-required",
        appVersion: "0.2.0",
      },
    });
    expect(retried.statusCode).toBe(200);
    const [afterRetry] = await identities.listDesktopDevices(
      afterFailure!.userId,
    );
    expect(afterRetry?.lmsSessionState).toBe("login-required");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/private/desktop/heartbeat",
      headers: { cookie },
      payload: {
        lmsSessionState: "login-required",
        appVersion: "0.2.0",
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("emits the previous attendance day's post-deadline event before rollover replaces it", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T03:59:00+09:00"));
    const record = vi.fn();
    try {
      const app = await buildApp({
        allowDevBootstrap: true,
        notificationEventSink: { record },
      });
      const cookie = await bootstrapDesktop(app);
      const previous = await app.inject({
        method: "POST",
        url: "/api/private/desktop/attendance-snapshot",
        headers: { cookie },
        payload: {
          ...attendancePayload(
            new Date("2026-08-01T03:59:00+09:00").toISOString(),
            true,
          ),
          attendanceDate: "2026-07-31",
        },
      });
      expect(previous.statusCode).toBe(200);
      record.mockClear();

      now.mockReturnValue(
        Date.parse("2026-08-01T04:05:00+09:00"),
      );
      const nextDay = await app.inject({
        method: "POST",
        url: "/api/private/desktop/attendance-snapshot",
        headers: { cookie },
        payload: {
          ...attendancePayload(
            new Date("2026-08-01T04:05:00+09:00").toISOString(),
            false,
          ),
          attendanceDate: "2026-08-01",
        },
      });
      expect(nextDay.statusCode).toBe(200);
      expect(record).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceEventId:
            "attendance:2026-07-31:evening:after",
          attendanceDate: "2026-07-31",
          phase: "evening",
          minutesRemaining: null,
        }),
      );
      await app.close();
    } finally {
      now.mockRestore();
    }
  });

  it("rejects malformed and future attendance snapshots", async () => {
    const app = await buildApp({ allowDevBootstrap: true });
    const cookie = await bootstrapDesktop(app);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/private/desktop/attendance-snapshot",
      headers: { cookie },
      payload: {
        ...attendancePayload(new Date().toISOString(), true),
        attendanceDate: "2026-02-31",
      },
    });
    expect(malformed.statusCode).toBe(400);

    const future = await app.inject({
      method: "POST",
      url: "/api/private/desktop/attendance-snapshot",
      headers: { cookie },
      payload: attendancePayload(
        new Date(Date.now() + 10 * 60_000).toISOString(),
        true,
      ),
    });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toEqual({
      error: "ATTENDANCE_COLLECTION_TIME_INVALID",
    });
    await app.close();
  });

  it("shows the same attendance snapshot to a paired mobile device", async () => {
    const app = await buildApp({ allowDevBootstrap: true });
    const desktopCookie = await bootstrapDesktop(app);
    const mobileCookie = await pairMobile(app, desktopCookie);
    const collectedAt = new Date(Date.now() - 1_000).toISOString();
    await app.inject({
      method: "POST",
      url: "/api/private/desktop/attendance-snapshot",
      headers: { cookie: desktopCookie },
      payload: attendancePayload(collectedAt, true),
    });

    const mobile = await app.inject({
      method: "GET",
      url: "/api/private/dashboard",
      headers: { cookie: mobileCookie },
    });
    expect(mobile.statusCode).toBe(200);
    expect(mobile.json()).toMatchObject({
      attendance: {
        snapshot: {
          collectedAt,
          sourceDeviceId: "demo-desktop",
        },
      },
      devices: [{ id: "demo-desktop", health: "online" }],
    });
    await app.close();
  });

  it("revokes only the Jungle Bell desktop session on logout", async () => {
    const app = await buildApp({ allowDevBootstrap: true });
    const cookie = await bootstrapDesktop(app);
    const logout = await app.inject({
      method: "DELETE",
      url: "/api/private/desktop/session",
      headers: mutationHeaders(cookie),
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    const status = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(401);
    await app.close();
  });

  it("never enables the development bootstrap unless explicitly configured", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dev/desktop-session",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

function attendancePayload(collectedAt: string, morningChecked: boolean) {
  return {
    attendanceDate: "2026-07-31",
    cohortId: "cohort-7",
    cohortStatus: "active",
    cohortStartDate: "2026-07-01",
    cohortEndDate: "2026-08-01",
    morningChecked,
    eveningChecked: false,
    collectedAt,
  };
}
