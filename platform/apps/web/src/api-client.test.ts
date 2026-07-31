import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveMobilePairing,
  claimPairing,
  claimPairingByManualCode,
  completePairing,
  createMobilePairing,
  disconnectLms,
  disconnectMobileDeviceSession,
  getCompanionAttendanceDashboard,
  getDesktopAttendanceDashboard,
  getDesktopAuthStatus,
  getMobilePairingStatus,
  getMobileDeviceSessions,
  getVapidPublicKey,
  registerPushSubscription,
  revokeMobileDeviceSession,
  sendServerPushTest,
} from "./api-client";

const pairingId = "jbc_0123456789abcdef0123456789abcdef";
const installationId = `jbmi_${"f".repeat(32)}`;
const claimReceipt = `jbcr_${"a".repeat(64)}`;
const qrPayload =
  `https://bell.example.com/pair#pairing=${pairingId}` +
  `&challenge=jbp_${"b".repeat(64)}`;
const fetchMock = vi.fn();
const devices = [
  {
    id: "demo-desktop",
    lastVerifiedAt: "2026-07-30T00:45:22.000Z",
    lastSeenAt: "2026-07-30T01:02:03.000Z",
    lmsSessionState: "connected",
    health: "online",
    appVersion: "0.1.0",
  },
] as const;
const attendance = {
  status: "available",
  freshness: "fresh",
  lastSyncedAt: "2026-07-30T01:02:03.000Z",
  snapshot: {
    attendanceDate: "2026-07-30",
    cohortId: "cohort-7",
    cohortStatus: "active",
    cohortStartDate: "2026-07-01",
    cohortEndDate: "2026-08-01",
    morningChecked: true,
    eveningChecked: false,
    collectedAt: "2026-07-30T01:02:03.000Z",
    sourceDeviceId: "demo-desktop",
    version: 4,
  },
} as const;

describe("same-origin API client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads desktop status through a credentialed same-origin request", async () => {
    respondJson({
      authenticated: true,
      user: { id: "user-1" },
      desktop: devices[0],
    });

    await expect(getDesktopAuthStatus()).resolves.toEqual({
      state: "connected",
      desktopId: "demo-desktop",
      lastVerifiedAt: "2026-07-30T00:45:22.000Z",
      lastSeenAt: "2026-07-30T01:02:03.000Z",
      health: "online",
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/private/desktop/status",
      expect.objectContaining({
        credentials: "include",
        headers: {},
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "authorization",
    );
  });

  it("treats a 401 desktop status as disconnected", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "DEVICE_SESSION_INVALID" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(getDesktopAuthStatus()).resolves.toEqual({
      state: "disconnected",
      desktopId: null,
      lastVerifiedAt: null,
      lastSeenAt: null,
      health: null,
    });
  });

  it("reads one strict attendance DTO from the separate desktop and companion routes", async () => {
    respondJson({
      desktop: { id: "demo-desktop" },
      devices,
      attendance,
    });
    respondJson({
      device: { id: "jbd_mobile", label: "테스트 휴대폰" },
      devices,
      attendance,
    });

    await expect(getDesktopAttendanceDashboard()).resolves.toEqual({
      state: "loaded",
      attendance,
      devices,
    });
    await expect(getCompanionAttendanceDashboard()).resolves.toEqual({
      state: "loaded",
      attendance,
      devices,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/private/desktop/dashboard",
      expect.objectContaining({
        credentials: "include",
        headers: {},
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/private/dashboard",
      expect.objectContaining({
        credentials: "include",
        headers: {},
      }),
    );
  });

  it("returns an explicit auth-required attendance state for 401", async () => {
    respondJson({ error: "DEVICE_SESSION_INVALID" }, 401);
    respondJson({ error: "DEVICE_SESSION_INVALID" }, 401);

    await expect(getDesktopAttendanceDashboard()).resolves.toEqual({
      state: "auth-required",
    });
    await expect(getCompanionAttendanceDashboard()).resolves.toEqual({
      state: "auth-required",
    });
  });

  it("accepts an unavailable snapshot with local PC state metadata", async () => {
    const unavailable = {
      status: "unavailable",
      freshness: "missing",
      lastSyncedAt: null,
      snapshot: null,
    } as const;
    respondJson({
      device: { id: "jbd_mobile", label: "테스트 휴대폰" },
      devices: [
        {
          ...devices[0],
          lmsSessionState: "login-required",
          health: "offline",
        },
      ],
      attendance: unavailable,
    });

    await expect(getCompanionAttendanceDashboard()).resolves.toEqual({
      state: "loaded",
      attendance: unavailable,
      devices: [
        {
          ...devices[0],
          lmsSessionState: "login-required",
          health: "offline",
        },
      ],
    });
  });

  it.each([
    {
      label: "an unknown root field",
      response: {
        desktop: { id: "demo-desktop" },
        devices,
        attendance,
        cookies: "must-not-cross-the-boundary",
      },
    },
    {
      label: "a mismatched collection timestamp",
      response: {
        desktop: { id: "demo-desktop" },
        devices,
        attendance: {
          ...attendance,
          lastSyncedAt: "2026-07-30T01:02:04.000Z",
        },
      },
    },
    {
      label: "an invalid cohort state",
      response: {
        desktop: { id: "demo-desktop" },
        devices,
        attendance: {
          ...attendance,
          snapshot: {
            ...attendance.snapshot,
            cohortStatus: "secret",
          },
        },
      },
    },
    {
      label: "device metadata with an unknown field",
      response: {
        desktop: { id: "demo-desktop" },
        devices: [
          {
            ...devices[0],
            rawCookies: [],
          },
        ],
        attendance,
      },
    },
  ])("rejects $label in an attendance response", async ({ response }) => {
    respondJson(response);

    await expect(getDesktopAttendanceDashboard()).rejects.toThrow(
      "API_RESPONSE_INVALID",
    );
  });

  it("strictly rejects malformed or extended desktop status responses", async () => {
    respondJson({
      authenticated: true,
      user: { id: "user-1" },
      desktop: devices[0],
      desktopToken: "must-not-cross-the-boundary",
    });

    await expect(getDesktopAuthStatus()).rejects.toThrow(
      "API_RESPONSE_INVALID",
    );
  });

  it("disconnects through a credentialed same-origin DELETE", async () => {
    respondNoContent();

    await expect(disconnectLms()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/private/desktop/session",
      expect.objectContaining({
        credentials: "include",
        headers: {},
        method: "DELETE",
      }),
    );
  });

  it("lists, revokes, and signs out mobile device sessions", async () => {
    const sessionId = `jbsi_${"1".repeat(32)}`;
    respondJson({
      sessions: [
        {
          sessionId,
          deviceId: `jbd_${"2".repeat(32)}`,
          deviceLabel: "모바일 PWA · iPhone",
          scopes: [
            "attendance:read",
            "notifications:receive",
            "preferences:read",
            "preferences:write",
          ],
          createdAt: "2026-07-30T00:00:00.000Z",
          expiresAt: "2026-08-29T00:00:00.000Z",
          revokedAt: null,
          status: "active",
        },
      ],
    });
    respondNoContent();
    respondNoContent();

    await expect(getMobileDeviceSessions()).resolves.toMatchObject({
      sessions: [{ sessionId, status: "active" }],
    });
    await expect(revokeMobileDeviceSession(sessionId)).resolves.toBeUndefined();
    await expect(disconnectMobileDeviceSession()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/private/desktop/mobile-sessions/${sessionId}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/private/mobile/session",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("creates, reads, and approves desktop pairing without native IPC", async () => {
    respondJson({
      pairingId,
      qrPayload,
      manualCode: "01ABCDEFGH",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });
    respondJson({
      status: "claimed",
      claim: {
        claimId: pairingId,
        deviceLabel: "iPhone",
        confirmationCode: "1A2F",
      },
    });
    respondNoContent();

    await expect(createMobilePairing()).resolves.toEqual({
      pairingId,
      qrPayload,
      manualCode: "01ABCDEFGH",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });
    await expect(getMobilePairingStatus(pairingId)).resolves.toEqual({
      status: "claimed",
      claim: {
        claimId: pairingId,
        deviceLabel: "iPhone",
        confirmationCode: "1A2F",
      },
    });
    await expect(
      approveMobilePairing(pairingId, pairingId),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/pairings",
      expect.objectContaining({
        credentials: "include",
        headers: {},
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/pairings/${pairingId}`,
      expect.objectContaining({
        credentials: "include",
        headers: {},
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/pairings/${pairingId}/approve`,
      expect.objectContaining({
        body: JSON.stringify({ claimId: pairingId }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
  });

  it("strictly validates pairing response identifiers and QR contents", async () => {
    respondJson({
      pairingId,
      qrPayload: qrPayload.replace(pairingId, `jbc_${"c".repeat(32)}`),
      manualCode: "01ABCDEFGH",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });

    await expect(createMobilePairing()).rejects.toThrow(
      "API_RESPONSE_INVALID",
    );
  });

  it("accepts a no-content pairing completion without reading JSON", async () => {
    respondNoContent();

    await expect(
      completePairing(pairingId, {
        claimId: pairingId,
        claimReceipt,
        status: "awaiting-desktop-approval",
      }),
    ).resolves.toBe("completed");
  });

  it.each([200, 201])(
    "rejects the legacy JSON-token pairing completion with status %i",
    async (status) => {
      respondJson({ token: `jbs_${"e".repeat(64)}` }, status);

      await expect(
        completePairing(pairingId, {
          claimId: pairingId,
          claimReceipt,
          status: "awaiting-desktop-approval",
        }),
      ).rejects.toThrow("API_RESPONSE_INVALID");
    },
  );

  it("waits only for the explicit not-approved completion conflict", async () => {
    respondJson({ error: "PAIRING_NOT_APPROVED" }, 409);
    respondJson({ error: "PAIRING_ALREADY_COMPLETED" }, 409);
    const claim = {
      claimId: pairingId,
      claimReceipt,
      status: "awaiting-desktop-approval" as const,
    };

    await expect(completePairing(pairingId, claim)).resolves.toBe("waiting");
    await expect(completePairing(pairingId, claim)).rejects.toThrow(
      "PAIRING_ALREADY_COMPLETED",
    );
  });

  it("strictly parses every remaining JSON response", async () => {
    respondJson({
      claimId: pairingId,
      claimReceipt,
      status: "awaiting-desktop-approval",
    });
    respondJson({
      claimId: pairingId,
      claimReceipt,
      status: "awaiting-desktop-approval",
    });
    respondJson({ publicKey: "B".repeat(87) });
    respondJson({ subscriptionId: `jbps_${"d".repeat(64)}` });
    respondJson({
      results: [{ status: "delivered", statusCode: 201 }],
    });
    await expect(
      claimPairing({
        pairingId,
        challenge: `jbp_${"b".repeat(64)}`,
        deviceLabel: "iPhone",
        installationId,
      }),
    ).resolves.toMatchObject({ claimId: pairingId });
    await expect(
      claimPairingByManualCode({
        manualCode: "01abc-defgh",
        deviceLabel: "Installed PWA",
        installationId,
      }),
    ).resolves.toMatchObject({ claimId: pairingId });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/pairing-claims",
      expect.objectContaining({
        body: JSON.stringify({
          manualCode: "01ABCDEFGH",
          deviceLabel: "Installed PWA",
          installationId,
        }),
      }),
    );
    await expect(getVapidPublicKey()).resolves.toEqual({
      publicKey: "B".repeat(87),
    });
    await expect(
      registerPushSubscription({
        endpoint: "https://updates.push.services.mozilla.com/wpush/example",
        expirationTime: null,
        keys: { auth: "auth", p256dh: "p256dh" },
      }),
    ).resolves.toEqual({ subscriptionId: `jbps_${"d".repeat(64)}` });
    await expect(sendServerPushTest()).resolves.toEqual({
      results: [{ status: "delivered" }],
    });
  });

  it("rejects unknown fields from non-desktop API responses", async () => {
    respondJson({
      publicKey: "B".repeat(87),
      privateKey: "must-not-be-accepted",
    });

    await expect(getVapidPublicKey()).rejects.toThrow(
      "API_RESPONSE_INVALID",
    );
  });
});

function respondJson(value: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function respondNoContent(): void {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
}
