import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../apps/api-worker/src/index";
import { DESKTOP_SESSION_TTL_MS, MOBILE_SESSION_TTL_MS, PAIRING_TTL_MS } from "../../apps/api-worker/src/services/pairing-service";
import { DESKTOP_ONLINE_WINDOW_MS } from "../../shared/renewal/attendance-policy";
import { planAttendanceNotifications } from "../../apps/jobs-runner/src/services/attendance-notification-service";
import { hashAppSessionToken, sha256Hex } from "../../shared/renewal/crypto";
import { MemoryRenewalStore } from "../../shared/tests/helpers/memory-renewal-store";
import { runMealPublicationLifecycle } from "../../apps/jobs-runner/src/services/meal-publication-service";
import {
  DESKTOP_ENROLLMENT_POLICY,
  MANUAL_PAIRING_CLAIM_POLICY,
  PAIRING_CREATION_POLICY,
} from "../../shared/domain/enrollment-policy";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const SECRET = "test-pairing-secret-that-is-at-least-32-bytes";

afterEach(() => vi.useRealTimers());

function environment(store: MemoryRenewalStore) {
  return {
    DB: {} as D1Database,
    DATA_BUCKET: {} as R2Bucket,
    PAIRING_SECRET: SECRET,
    RENEWAL_STORE: store,
  };
}

async function jsonRequest(env: ReturnType<typeof environment>, path: string, body: unknown, authorization?: string) {
  return app.request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify(body),
  }, env);
}

function responseCookie(response: Response, name: string): string {
  const match = new RegExp(`(?:^|, )(${name}=[^;,]*)`, "u").exec(response.headers.get("set-cookie") ?? "");
  if (!match?.[1]) throw new Error(`Missing ${name} response cookie`);
  return match[1];
}

function completePairingRequest(
  env: ReturnType<typeof environment>,
  pairingId: string,
  pendingCookie: string,
) {
  return app.request(`https://app.test/api/pairings/${pairingId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", cookie: pendingCookie },
    body: JSON.stringify({}),
  }, env);
}

async function seedDesktop(
  store: MemoryRenewalStore,
  input: { installationId: string; nowEpochMs: number },
): Promise<string> {
  const sessionId = `jbas_${crypto.randomUUID()}`;
  await store.enrollDesktop({
    candidateUserId: crypto.randomUUID(),
    installationId: input.installationId,
    sessionId,
    tokenSha256: await sha256Hex(sessionId),
    nowEpochMs: input.nowEpochMs,
    expiresAtEpochMs: input.nowEpochMs + DESKTOP_SESSION_TTL_MS,
  });
  return store.desktops.get(input.installationId)!.userId;
}

describe("renewal API", () => {
  it("enrolls an installation and persists only the server credential hash", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const response = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ accessToken: string; expiresAt: string }>();
    expect(body.accessToken).toMatch(/^jbd_[a-f0-9]{64}$/);
    const persisted = JSON.stringify(store.persistedValues);
    expect(persisted).not.toContain(body.accessToken);
    expect(persisted).toContain(await hashAppSessionToken(body.accessToken));

    const heartbeat = await jsonRequest(env, "/api/desktop/heartbeat", {
      lmsSessionState: "connected",
      appVersion: "0.5.0",
    }, body.accessToken);
    expect(heartbeat.status).toBe(200);
    const firstUserId = store.desktops.get("desktop-installation-1")!.userId;
    expect(store.preferences.get(firstUserId)).toEqual({
      morning: true,
      evening: true,
      skipSunday: false,
      skipAttendanceDate: null,
    });

    const second = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-2",
    });
    expect(second.status).toBe(201);
    expect(new Set([...store.desktops.values()].map((device) => device.userId))).toHaveLength(2);
  });

  it("rejects every attempt to send LMS credentials to installation enrollment", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const response = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
      cookies: [{ name: "access_token", value: "must-not-reach-server" }],
    });
    expect(response.status).toBe(400);
  });

  it("allows exactly one enrollment for a fresh installation identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const firstEnv = environment(store);
    const secondEnv = environment(store);

    const responses = await Promise.all([
      jsonRequest(firstEnv, "/api/desktop/installations", {
        installationId: "shared-desktop-installation",
      }),
      jsonRequest(secondEnv, "/api/desktop/installations", {
        installationId: "shared-desktop-installation",
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const active = [...store.sessions.values()].filter((session) => session.kind === "desktop" && session.revokedAtEpochMs === null);
    expect(active).toHaveLength(1);
    expect(store.desktops.get("shared-desktop-installation")?.userId).toBe(active[0]!.userId);
  });

  it("rotates an authenticated desktop credential before absolute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const enrolled = await jsonRequest(env, "/api/desktop/installations", { installationId: "desktop-installation-1" });
    const original = await enrolled.json<{ accessToken: string }>();

    const rotated = await jsonRequest(env, "/api/desktop/installations/rotate", {}, original.accessToken);
    expect(rotated.status).toBe(200);
    const next = await rotated.json<{ accessToken: string; expiresAt: string }>();
    expect(next.accessToken).toMatch(/^jbd_[a-f0-9]{64}$/);
    expect(next.accessToken).not.toBe(original.accessToken);

    const heartbeat = (token: string) => jsonRequest(env, "/api/desktop/heartbeat", {
      lmsSessionState: "connected", appVersion: "0.5.0",
    }, token);
    expect((await heartbeat(original.accessToken)).status).toBe(401);
    expect((await heartbeat(next.accessToken)).status).toBe(200);
    expect((await jsonRequest(env, "/api/desktop/installations/rotate", {}, original.accessToken)).status).toBe(401);
  });

  it("allows the 200-installation campus NAT contract, then caps the IP burst", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const request = (index: number) => app.request(
      "https://app.test/api/desktop/installations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json", origin: "https://app.test", "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({ installationId: `campus-desktop-${index}` }),
      },
      env);
    const campusBurst = await Promise.all(Array.from({ length: 200 }, (_, index) => request(index)));
    expect(campusBurst.every((response) => response.status === 201)).toBe(true);
    const remainingAllowance = await Promise.all(Array.from({
      length: DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit - 200,
    }, (_, index) => request(200 + index)));
    expect(remainingAllowance.every((response) => response.status === 201)).toBe(true);
    expect((await request(DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit)).status).toBe(429);
    expect(store.desktops.size).toBe(DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit);
    expect(store.enrollmentAttempts.size).toBe(DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit + 1);
  });

  it("caps repeated enrollment attempts for one installation without lowering the NAT burst", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const attempt = () => app.request("https://app.test/api/desktop/installations", {
      method: "POST",
      headers: {
        "content-type": "application/json", origin: "https://app.test", "cf-connecting-ip": "203.0.113.20",
      },
      body: JSON.stringify({ installationId: "repeated-desktop-installation" }),
    }, env);

    expect((await attempt()).status).toBe(201);
    for (let index = 1; index < DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit; index += 1) {
      expect((await attempt()).status).toBe(409);
    }
    expect((await attempt()).status).toBe(429);
    expect(store.desktops.size).toBe(1);
  });

  it("accepts desktop enrollment without an Origin header", async () => {
    const store = new MemoryRenewalStore();
    const response = await app.request("https://app.test/api/desktop/installations", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30" },
      body: JSON.stringify({ installationId: "originless-desktop-installation" }),
    }, environment(store));

    expect(response.status).toBe(201);
    expect(store.desktops.has("originless-desktop-installation")).toBe(true);
  });

  it("keeps one active pairing per desktop and caps creation attempts by the authenticated installation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const enrolled = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "pairing-rate-desktop",
    });
    const { accessToken } = await enrolled.json<{ accessToken: string }>();
    const create = () => jsonRequest(env, "/api/pairings", {}, accessToken);

    expect((await create()).status).toBe(201);
    for (let index = 1; index < PAIRING_CREATION_POLICY.installationAttemptLimit; index += 1) {
      await expect(create()).resolves.toMatchObject({ status: 409 });
    }
    await expect(create()).resolves.toMatchObject({ status: 429 });
    expect(store.pairings.size).toBe(1);
    expect(store.pairingCreationAttempts.size).toBe(1);
  });

  it("allows a new pairing after the prior active pairing expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const enrolled = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "pairing-expiry-desktop",
    });
    const { accessToken } = await enrolled.json<{ accessToken: string }>();

    expect((await jsonRequest(env, "/api/pairings", {}, accessToken)).status).toBe(201);
    vi.setSystemTime(NOW + PAIRING_TTL_MS + 1);
    expect((await jsonRequest(env, "/api/pairings", {}, accessToken)).status).toBe(201);
    expect(store.pairings.size).toBe(2);
  });

  it("isolates manual-code limits by mobile installation behind a shared NAT", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const attempt = (installationId: string) => app.request("https://app.test/api/pairings/claims", {
      method: "POST",
      headers: {
        "content-type": "application/json", origin: "https://app.test", "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ manualCode: "0000000000", deviceLabel: "휴대폰", installationId }),
    }, env);
    const firstInstallation = `jbmi_${"a".repeat(32)}`;
    for (let index = 0; index < 10; index += 1) expect((await attempt(firstInstallation)).status).toBe(404);
    expect((await attempt(firstInstallation)).status).toBe(429);
    expect((await attempt(`jbmi_${"b".repeat(32)}`)).status).toBe(404);
  });

  it("allows 200 mobile installations behind a NAT and bounds manual-claim rate rows", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const attempt = (index: number) => app.request("https://app.test/api/pairings/claims", {
      method: "POST",
      headers: {
        "content-type": "application/json", origin: "https://app.test", "cf-connecting-ip": "203.0.113.40",
      },
      body: JSON.stringify({
        manualCode: "0000000000",
        deviceLabel: "휴대폰",
        installationId: `jbmi_${index.toString(16).padStart(32, "0")}`,
      }),
    }, env);

    const responses = [];
    for (let index = 0; index <= MANUAL_PAIRING_CLAIM_POLICY.ipAttemptLimit; index += 1) {
      responses.push(await attempt(index));
    }
    expect(responses.slice(0, 200).every((response) => response.status === 404)).toBe(true);
    expect(responses.filter((response) => response.status === 404)).toHaveLength(
      MANUAL_PAIRING_CLAIM_POLICY.ipAttemptLimit,
    );
    expect(responses.at(-1)?.status).toBe(429);
    expect(store.manualPairingAttempts.size).toBe(MANUAL_PAIRING_CLAIM_POLICY.ipAttemptLimit + 1);
  });

  it("rejects malformed manual-claim installation IDs before allocating rate state", async () => {
    const store = new MemoryRenewalStore();
    const response = await app.request("https://app.test/api/pairings/claims", {
      method: "POST",
      headers: {
        "content-type": "application/json", origin: "https://app.test", "cf-connecting-ip": "203.0.113.50",
      },
      body: JSON.stringify({ manualCode: "0000000000", deviceLabel: "휴대폰", installationId: "random-key" }),
    }, environment(store));

    expect(response.status).toBe(400);
    expect(store.manualPairingAttempts.size).toBe(0);
  });

  it("never accepts a desktop bearer at mobile or Push role boundaries", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const enrolled = await jsonRequest(env, "/api/desktop/installations", { installationId: "desktop-installation-1" });
    const { accessToken } = await enrolled.json<{ accessToken: string }>();
    for (const path of ["/api/mobile/attendance", "/api/mobile/notifications", "/api/push/vapid-public-key"]) {
      const response = await app.request(`https://app.test${path}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }, env);
      expect(response.status).toBe(401);
    }
  });

  it("rejects a desktop token when its installation is currently owned by another user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const desktop = store.desktops.get("desktop-installation-1")!;
    store.desktops.set(desktop.installationId, { ...desktop, userId: crypto.randomUUID() });

    const response = await app.request("https://app.test/api/desktop/mobile-sessions", {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });

  it("pairs once, issues an HttpOnly 365-day mobile session, and lets the PC revoke it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();

    const pairingResponse = await jsonRequest(env, "/api/pairings", {}, accessToken);
    expect(pairingResponse.status).toBe(201);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string; manualCode: string; expiresAt: string }>();
    expect(pairing.manualCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(new URL(pairing.qrPayload).origin).toBe("https://app.test");
    const fragment = new URL(pairing.qrPayload).hash.slice(1);
    const challenge = new URLSearchParams(fragment).get("challenge")!;
    expect(JSON.stringify([...store.pairings.values()])).not.toContain(challenge);
    expect(JSON.stringify([...store.pairings.values()])).not.toContain(pairing.manualCode);

    const claimed = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "내 휴대폰",
      installationId: `jbmi_${"a".repeat(32)}`,
    });
    expect(claimed.status).toBe(201);
    const claim = await claimed.json<{ claimId: string; status: string }>();
    const pendingCookie = responseCookie(claimed, "__Host-jb_pending_claim");
    const replayClaim = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "공격자",
      installationId: `jbmi_${"b".repeat(32)}`,
    });
    expect(replayClaim.status).toBe(409);

    const approved = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/approve`, {}, accessToken);
    expect(approved.status).toBe(204);
    const completed = await completePairingRequest(env, pairing.pairingId, pendingCookie);
    expect(completed.status).toBe(204);
    const setCookie = completed.headers.get("set-cookie")!;
    expect(setCookie).toContain("__Host-jb_device=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const mobileCookie = responseCookie(completed, "__Host-jb_device");

    const mobileProbe = await app.request("https://app.test/api/mobile/session", {
      headers: { cookie: mobileCookie },
    }, env);
    expect(mobileProbe.status).toBe(200);
    await expect(mobileProbe.json()).resolves.toMatchObject({ authenticated: true });

    const mobileSession = [...store.sessions.values()].find((session) => session.kind === "mobile")!;
    expect(mobileSession.expiresAtEpochMs - mobileSession.createdAtEpochMs).toBe(MOBILE_SESSION_TTL_MS);
    const devices = await app.request("https://app.test/api/desktop/mobile-sessions", {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    expect(await devices.json()).toMatchObject({ devices: [{
      deviceId: mobileSession.id,
      deviceLabel: "내 휴대폰",
      status: "active",
      pushEnabled: false,
    }] });

    const revoked = await app.request(`https://app.test/api/desktop/mobile-sessions/${mobileSession.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    expect(revoked.status).toBe(204);
    const revokedProbe = await app.request("https://app.test/api/mobile/session", {
      headers: { cookie: mobileCookie },
    }, env);
    expect(revokedProbe.status).toBe(401);
  });

  it("keeps the pending pairing proof out of JavaScript in a short HttpOnly cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const enrolled = await jsonRequest(env, "/api/desktop/installations", { installationId: "desktop-installation-1" });
    const { accessToken } = await enrolled.json<{ accessToken: string }>();
    const invalidCreate = await jsonRequest(env, "/api/pairings", { legacyProof: "must-not-be-accepted" }, accessToken);
    expect(invalidCreate.status).toBe(400);
    const pairingResponse = await jsonRequest(env, "/api/pairings", {}, accessToken);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string }>();
    const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge")!;
    const claimResponse = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/claims`, {
      challenge, deviceLabel: "내 휴대폰", installationId: `jbmi_${"5".repeat(32)}`,
    });
    expect(claimResponse.status).toBe(201);
    await expect(claimResponse.json()).resolves.toEqual({
      claimId: pairing.pairingId, status: "awaiting-desktop-approval",
    });
    const pendingCookie = claimResponse.headers.get("set-cookie")!;
    expect(pendingCookie).toContain("__Host-jb_pending_claim=");
    expect(pendingCookie).toContain("HttpOnly");
    expect(pendingCookie).toContain("SameSite=Strict");
    expect(pendingCookie).not.toContain("Max-Age=0");

    const invalidApproval = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/approve`, {
      claimReceipt: `jbcr_${"a".repeat(64)}`,
    }, accessToken);
    expect(invalidApproval.status).toBe(400);
    expect((await jsonRequest(env, `/api/pairings/${pairing.pairingId}/approve`, {}, accessToken)).status).toBe(204);
    const completed = await app.request(`https://app.test/api/pairings/${pairing.pairingId}/complete`, {
      method: "POST",
      headers: { origin: "https://app.test", cookie: pendingCookie.split(";", 1)[0]!, "content-type": "application/json" },
      body: JSON.stringify({}),
    }, env);
    expect(completed.status).toBe(204);
    const completedCookies = completed.headers.get("set-cookie")!;
    expect(completedCookies).toContain("__Host-jb_device=");
    expect(completedCookies).toContain("__Host-jb_pending_claim=;");

    const leakedProof = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/complete`, {
      claimReceipt: `jbcr_${"a".repeat(64)}`,
    });
    expect(leakedProof.status).toBe(400);
  });

  it("omits claim details after a claimed pairing expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const pairingResponse = await jsonRequest(env, "/api/pairings", {}, accessToken);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string }>();
    const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge")!;
    const claimed = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "만료될 휴대폰",
      installationId: `jbmi_${"c".repeat(32)}`,
    });
    expect(claimed.status).toBe(201);

    vi.setSystemTime(NOW + 2 * 60_000 + 1);
    const status = await app.request(`https://app.test/api/pairings/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ status: "expired", claim: null });
  });

  it("lets an approved mobile finish before the pending proof expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const pairingResponse = await jsonRequest(env, "/api/pairings", {}, accessToken);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string }>();
    const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge")!;
    const claimed = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "경계 승인 휴대폰",
      installationId: `jbmi_${"d".repeat(32)}`,
    });
    const pendingCookie = responseCookie(claimed, "__Host-jb_pending_claim");

    vi.setSystemTime(NOW + PAIRING_TTL_MS - 1);
    const approved = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/approve`, {}, accessToken);
    expect(approved.status).toBe(204);

    const approvedStatus = await app.request(`https://app.test/api/pairings/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    await expect(approvedStatus.json()).resolves.toEqual({ status: "approved", claim: null });

    const completed = await completePairingRequest(env, pairing.pairingId, pendingCookie);
    expect(completed.status).toBe(204);
    expect(completed.headers.get("set-cookie")).toContain("__Host-jb_device=");

    const completedStatus = await app.request(`https://app.test/api/pairings/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    await expect(completedStatus.json()).resolves.toEqual({ status: "completed", claim: null });
  });

  it("rejects pending proof completion and replay after the original pairing expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const enrolled = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await enrolled.json<{ accessToken: string }>();

    async function approvedPairing(suffix: string) {
      const created = await jsonRequest(env, "/api/pairings", {}, accessToken);
      const pairing = await created.json<{ pairingId: string; qrPayload: string }>();
      const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge")!;
      const claimed = await jsonRequest(env, `/api/pairings/${pairing.pairingId}/claims`, {
        challenge,
        deviceLabel: `만료 검증 휴대폰 ${suffix}`,
        installationId: `jbmi_${suffix.repeat(32)}`,
      });
      expect(claimed.status).toBe(201);
      expect((await jsonRequest(env, `/api/pairings/${pairing.pairingId}/approve`, {}, accessToken)).status).toBe(204);
      return {
        pairingId: pairing.pairingId,
        pendingCookie: responseCookie(claimed, "__Host-jb_pending_claim"),
      };
    }

    const unconsumed = await approvedPairing("e");
    const consumed = await approvedPairing("f");
    expect((await completePairingRequest(env, consumed.pairingId, consumed.pendingCookie)).status).toBe(204);

    vi.setSystemTime(NOW + PAIRING_TTL_MS + 1);
    expect((await completePairingRequest(env, unconsumed.pairingId, unconsumed.pendingCookie)).status).toBe(410);
    expect((await completePairingRequest(env, consumed.pairingId, consumed.pendingCookie)).status).toBe(410);
  });

  it("accepts only the newest desktop attendance snapshot and rejects future client time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const snapshot = {
      attendanceDate: "2026-08-03",
      cohortId: "cohort-1",
      cohortStatus: "active",
      cohortStartDate: "2026-07-01",
      cohortEndDate: "2026-12-31",
      morningChecked: false,
      eveningChecked: false,
      collectedAt: "2026-08-03T00:00:00.000Z",
    };
    const put = (body: unknown) => app.request("https://app.test/api/desktop/attendance", {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, env);
    const initial = await put(snapshot);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json<Record<string, unknown>>();
    expect(Object.keys(initialBody)).toEqual(["attendance", "freshness"]);
    expect(initialBody.freshness).toBe("fresh");
    expect(Object.keys(initialBody.attendance as Record<string, unknown>)).not.toContain("receivedAt");
    const older = await put({ ...snapshot, collectedAt: "2026-08-02T23:59:59.000Z", morningChecked: true });
    expect(await older.json()).toMatchObject({ attendance: { morningChecked: false }, freshness: "fresh" });
    const future = await put({ ...snapshot, collectedAt: "2026-08-03T00:05:01.000Z" });
    expect(future.status).toBe(400);
  });

  it("rejects an attendance snapshot when the desktop heartbeat cannot prove ownership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    vi.spyOn(store, "recordDesktopHeartbeat").mockResolvedValue(false);

    const response = await app.request("https://app.test/api/desktop/attendance", {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        attendanceDate: "2026-08-03",
        cohortId: "cohort-1",
        cohortStatus: "active",
        cohortStartDate: "2026-07-01",
        cohortEndDate: "2026-12-31",
        morningChecked: false,
        eveningChecked: false,
        collectedAt: "2026-08-03T00:00:00.000Z",
      }),
    }, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "DESKTOP_NOT_REGISTERED" });
    expect(store.snapshots.size).toBe(0);
  });

  it("reports missing and stale attendance freshness without inventing a fresh snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/api/desktop/installations", {
      installationId: "desktop-installation-1",
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();

    const read = () => app.request("https://app.test/api/desktop/attendance", {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    await expect((await read()).json()).resolves.toEqual({ attendance: null, freshness: "missing" });

    const userId = store.desktops.get("desktop-installation-1")!.userId;
    await store.putNewestAttendanceSnapshot({
      userId,
      sourceInstallationId: "desktop-installation-1",
      attendanceDate: "2026-08-03",
      cohortId: "cohort-1",
      cohortStatus: "active",
      cohortStartDate: "2026-07-01",
      cohortEndDate: "2026-12-31",
      morningChecked: false,
      eveningChecked: false,
      collectedAtEpochMs: NOW - 15 * 60_000 - 1,
      receivedAtEpochMs: NOW,
    });

    await expect((await read()).json()).resolves.toMatchObject({
      attendance: { collectedAt: "2026-08-02T23:44:59.999Z" },
      freshness: "stale",
    });
  });

  it("adds explicit desktop health to mobile attendance without changing the desktop envelope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const userId = await seedDesktop(store, { installationId: "desktop-installation-1", nowEpochMs: NOW });
    await store.recordDesktopHeartbeat({
      userId, installationId: "desktop-installation-1", lmsSessionState: "connected",
      appVersion: "0.5.0", nowEpochMs: NOW,
    });
    const mobileToken = `jbs_${"7".repeat(64)}`;
    store.sessions.set("mobile-session", {
      id: "mobile-session", userId, installationId: `jbmi_${"7".repeat(32)}`,
      kind: "mobile", label: "내 휴대폰", tokenSha256: await hashAppSessionToken(mobileToken),
      createdAtEpochMs: NOW, expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
    });
    const readMobile = () => app.request("https://app.test/api/mobile/attendance", {
      headers: { cookie: `jb_device=${mobileToken}` },
    }, environment(store));

    await expect((await readMobile()).json()).resolves.toEqual({
      attendance: null,
      freshness: "missing",
      devices: [{
        id: "desktop-installation-1", deviceLabel: "PC 앱", lastSeenAt: new Date(NOW).toISOString(),
        lmsSessionState: "connected", health: "online", appVersion: "0.5.0",
      }],
    });

    vi.setSystemTime(NOW + DESKTOP_ONLINE_WINDOW_MS + 1);
    await expect((await readMobile()).json()).resolves.toMatchObject({
      devices: [{ id: "desktop-installation-1", health: "offline" }],
    });
  });

  it("deduplicates offline fallback notifications per attendance slot", async () => {
    const store = new MemoryRenewalStore();
    const now = Date.parse("2026-08-03T00:50:00.000Z");
    const userId = await seedDesktop(store, {
      installationId: "desktop-installation-1", nowEpochMs: now - 10 * 60_000,
    });
    expect(await planAttendanceNotifications(store, now)).toBe(1);
    expect(await planAttendanceNotifications(store, now + 60_000)).toBe(0);
    const notification = [...store.notifications.values()][0]!;
    expect(notification.sourceEventId).toBe("attendance:2026-08-03:morning:before-10");
    expect(JSON.parse(notification.payloadJson)).toMatchObject({
      status: "unverified",
      reason: "desktop-offline",
      expiresAtEpochMs: Date.parse("2026-08-03T01:00:00.000Z"),
    });
    expect(notification.path).toBe("/dashboard.html#attendance");
    expect(notification.userId).toBe(userId);
  });

  it("honors one-day and Sunday attendance notification skips on the server", async () => {
    for (const scenario of [
      { now: Date.parse("2026-08-03T00:50:00.000Z"), skipSunday: false, skipAttendanceDate: "2026-08-03" },
      { now: Date.parse("2026-08-02T00:50:00.000Z"), skipSunday: true, skipAttendanceDate: null },
    ]) {
      const store = new MemoryRenewalStore();
      const userId = await seedDesktop(store, {
        installationId: "desktop-installation-1",
        nowEpochMs: scenario.now,
      });
      await store.setAttendancePreference(userId, {
        morning: true,
        evening: true,
        skipSunday: scenario.skipSunday,
        skipAttendanceDate: scenario.skipAttendanceDate,
      }, scenario.now);
      expect(await planAttendanceNotifications(store, scenario.now)).toBe(0);
      expect(store.notifications.size).toBe(0);
    }
  });

  it.each([
    { name: "login-required", state: "login-required" as const, snapshotAge: null, reason: "login-required" },
    { name: "missing snapshot", state: "connected" as const, snapshotAge: null, reason: "snapshot-missing" },
    { name: "stale snapshot", state: "connected" as const, snapshotAge: 16 * 60_000, reason: "snapshot-stale" },
    { name: "fresh unchecked snapshot", state: "connected" as const, snapshotAge: 60_000, reason: null },
  ])("classifies the $name attendance fallback", async ({ state, snapshotAge, reason }) => {
    const store = new MemoryRenewalStore();
    const now = Date.parse("2026-08-03T00:50:00.000Z");
    const userId = await seedDesktop(store, {
      installationId: "desktop-installation-1", nowEpochMs: now,
    });
    await store.recordDesktopHeartbeat({ userId, installationId: "desktop-installation-1", lmsSessionState: state, appVersion: "0.5.0", nowEpochMs: now });
    if (snapshotAge !== null) {
      await store.putNewestAttendanceSnapshot({
        userId, sourceInstallationId: "desktop-installation-1", attendanceDate: "2026-08-03", cohortId: "cohort",
        cohortStatus: "active", cohortStartDate: "2026-07-01", cohortEndDate: "2026-12-31",
        morningChecked: false, eveningChecked: false, collectedAtEpochMs: now - snapshotAge, receivedAtEpochMs: now,
      });
    }
    expect(await planAttendanceNotifications(store, now)).toBe(1);
    expect(JSON.parse([...store.notifications.values()][0]!.payloadJson).reason).toBe(reason);
  });

  it("uses wildcard non-credentialed CORS only for public data", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const publicPreflight = await app.request("https://app.test/api/public/meals", {
      method: "OPTIONS",
      headers: { origin: "https://other.example", "access-control-request-method": "GET" },
    }, env);
    expect(publicPreflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(publicPreflight.headers.get("access-control-allow-credentials")).toBeNull();

    const privatePreflight = await app.request("https://app.test/api/desktop/mobile-sessions", {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "GET" },
    }, env);
    expect(privatePreflight.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(privatePreflight.headers.get("access-control-allow-credentials")).toBe("true");

    const rejected = await app.request("https://app.test/api/desktop/heartbeat", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ lmsSessionState: "unknown", appVersion: null }),
    }, env);
    expect(rejected.status).toBe(403);
  });

  it("uses the dashboard as the canonical public root", async () => {
    const response = await app.request("https://app.test/", {}, environment(new MemoryRenewalStore()));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/dashboard.html");
  });

  it("advertises and persists Web Push using only the App Worker public key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const mobileToken = `jbs_${"c".repeat(64)}`;
    store.sessions.set("mobile-session", {
      id: "mobile-session",
      userId: "user-1",
      installationId: `jbmi_${"d".repeat(32)}`,
      kind: "mobile",
      label: "휴대폰",
      tokenSha256: await hashAppSessionToken(mobileToken),
      createdAtEpochMs: NOW,
      expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW,
      revokedAtEpochMs: null,
      sourcePairingId: null,
    });
    const baseEnv = environment(store);
    const headers = { cookie: `jb_device=${mobileToken}`, origin: "https://app.test" };

    const missingKey = await app.request("https://app.test/api/push/vapid-public-key", { headers }, baseEnv);
    expect(missingKey.status).toBe(503);

    const missingKeyRegistration = await app.request("https://app.test/api/push/subscriptions", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/device",
        keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
      }),
    }, baseEnv);
    expect(missingKeyRegistration.status).toBe(503);
    expect(store.subscriptions.size).toBe(0);

    const configured = await app.request("https://app.test/api/push/vapid-public-key", { headers }, {
      ...baseEnv,
      VAPID_PUBLIC_KEY: " public-vapid-key ",
    });
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toEqual({ publicKey: "public-vapid-key" });

    const registration = await app.request("https://app.test/api/push/subscriptions", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/device",
        keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
      }),
    }, { ...baseEnv, VAPID_PUBLIC_KEY: "public-vapid-key" });
    expect(registration.status).toBe(201);
    expect(store.subscriptions.size).toBe(1);
  });

  it("queues a rate-limited authenticated test push for the OCI Jobs tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const mobileToken = `jbs_${"e".repeat(64)}`;
    store.sessions.set("mobile-session", {
      id: "mobile-session", userId: "user-1", installationId: `jbmi_${"f".repeat(32)}`,
      kind: "mobile", label: "내 휴대폰", tokenSha256: await hashAppSessionToken(mobileToken),
      createdAtEpochMs: NOW, expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
    });
    store.subscriptions.set("current-push", {
      id: "current-push", userId: "user-1", sessionId: "mobile-session",
      endpoint: "https://fcm.googleapis.com/fcm/send/current", p256dh: "p".repeat(65), auth: "a".repeat(24),
      createdAtEpochMs: NOW, revokedAtEpochMs: null,
    });
    store.subscriptions.set("other-push", {
      id: "other-push", userId: "user-1", sessionId: "other-mobile-session",
      endpoint: "https://fcm.googleapis.com/fcm/send/other", p256dh: "q".repeat(65), auth: "b".repeat(24),
      createdAtEpochMs: NOW, revokedAtEpochMs: null,
    });
    store.sessions.set("other-mobile-session", {
      id: "other-mobile-session", userId: "user-1", installationId: `jbmi_${"1".repeat(32)}`,
      kind: "mobile", label: "다른 휴대폰", tokenSha256: "9".repeat(64),
      createdAtEpochMs: NOW, expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
    });
    const env = environment(store);
    const request = () => app.request("https://app.test/api/mobile/notifications/test", {
      method: "POST",
      headers: { cookie: `jb_device=${mobileToken}`, origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({}),
    }, env);

    const response = await request();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ queued: 2 });
    expect([...store.deliveries.values()]).toHaveLength(2);
    expect([...store.deliveries.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: "current-push", status: "pending", attempts: 0 }),
      expect.objectContaining({ subscriptionId: "other-push", status: "pending", attempts: 0 }),
    ]));
    const history = await app.request("https://app.test/api/mobile/notifications", {
      headers: { cookie: `jb_device=${mobileToken}` },
    }, env);
    await expect(history.json()).resolves.toMatchObject({
      notifications: [{ kind: "test", attempt: 1 }],
    });
    expect(await request()).toHaveProperty("status", 429);
  });

  it("broadcasts a desktop test notification to every connected mobile and suppresses a duplicate PC poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const desktopToken = `jbd_${"2".repeat(64)}`;
    store.sessions.set("desktop-session", {
      id: "desktop-session", userId: "user-1", installationId: "desktop-installation-1",
      kind: "desktop", label: "PC", tokenSha256: await hashAppSessionToken(desktopToken),
      createdAtEpochMs: NOW, expiresAtEpochMs: NOW + DESKTOP_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
    });
    store.desktops.set("desktop-installation-1", {
      installationId: "desktop-installation-1", userId: "user-1", lastSeenAtEpochMs: NOW,
      lmsSessionState: "connected", appVersion: "0.5.0",
    });
    store.sessions.set("desktop-session-2", {
      id: "desktop-session-2", userId: "user-1", installationId: "desktop-installation-2",
      kind: "desktop", label: "PC 2", tokenSha256: "8".repeat(64), createdAtEpochMs: NOW,
      expiresAtEpochMs: NOW + DESKTOP_SESSION_TTL_MS, lastSeenAtEpochMs: NOW,
      revokedAtEpochMs: null, sourcePairingId: null,
    });
    store.desktops.set("desktop-installation-2", {
      installationId: "desktop-installation-2", userId: "user-1", lastSeenAtEpochMs: NOW,
      lmsSessionState: "connected", appVersion: "0.5.0",
    });
    for (const index of [1, 2]) {
      const sessionId = `mobile-session-${index}`;
      store.sessions.set(sessionId, {
        id: sessionId, userId: "user-1", installationId: `jbmi_${String(index).repeat(32)}`,
        kind: "mobile", label: `휴대폰 ${index}`, tokenSha256: String(index + 2).repeat(64),
        createdAtEpochMs: NOW, expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
        lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
      });
      store.subscriptions.set(`push-${index}`, {
        id: `push-${index}`, userId: "user-1", sessionId,
        endpoint: `https://fcm.googleapis.com/fcm/send/${index}`,
        p256dh: "p".repeat(65), auth: "a".repeat(24), createdAtEpochMs: NOW, revokedAtEpochMs: null,
      });
    }
    const response = await app.request("https://app.test/api/desktop/notifications/test", {
      method: "POST",
      headers: { authorization: `Bearer ${desktopToken}`, origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({ desktopDelivered: true }),
    }, environment(store));

    expect(response.status).toBe(202);
    const responseBody = await response.json<{ notificationId: string; queued: number }>();
    expect(responseBody).toMatchObject({ queued: 2 });
    expect([...store.deliveries.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ notificationId: responseBody.notificationId, subscriptionId: "push-1", status: "pending", attempts: 0 }),
      expect.objectContaining({ notificationId: responseBody.notificationId, subscriptionId: "push-2", status: "pending", attempts: 0 }),
    ]));
    expect(store.desktopDeliveries.get(`${responseBody.notificationId}:desktop-installation-1`)?.status)
      .toBe("delivered");
    await expect(store.listDesktopInbox("user-1", "desktop-installation-1", NOW, 20)).resolves.toHaveLength(0);
    await expect(store.listDesktopInbox("user-1", "desktop-installation-2", NOW, 20)).resolves.toHaveLength(1);
  });

  it("delivers and ACKs a meal publication with the canonical UUID notification id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const desktopToken = `jbd_${"a".repeat(64)}`;
    store.sessions.set("desktop-session", {
      id: "desktop-session", userId: "user-1", installationId: "desktop-installation-1",
      kind: "desktop", label: "PC", tokenSha256: await hashAppSessionToken(desktopToken),
      createdAtEpochMs: NOW, expiresAtEpochMs: NOW + DESKTOP_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
    });
    store.desktops.set("desktop-installation-1", {
      installationId: "desktop-installation-1", userId: "user-1", lastSeenAtEpochMs: NOW,
      lmsSessionState: "connected", appVersion: "0.5.0",
    });
    store.mealPreferences.set("user-1", {
      enabled: true, breakfast: false, lunch: true, dinner: false, updatedAtEpochMs: NOW - 60_000,
    });
    store.mealPosts.set("meal-post", {
      id: "meal-post", contentSha: "f".repeat(64), title: "2026년 8월 3일 중식",
      text: "현미밥과 된장국", publishedAt: new Date(NOW - 30_000).toISOString(),
      updatedAt: new Date(NOW - 30_000).toISOString(), firstSeenAt: new Date(NOW - 30_000).toISOString(),
      hasPriorVersion: false,
    });
    await expect(runMealPublicationLifecycle(store, NOW)).resolves.toEqual({
      processedPosts: 1, notifications: 1,
    });

    const headers = { authorization: `Bearer ${desktopToken}`, origin: "https://app.test" };
    const inbox = await app.request("https://app.test/api/desktop/notifications", { headers }, environment(store));
    const body = await inbox.json<{ notifications: Array<{ id: string; kind: string }> }>();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({ kind: "meal-published" });
    expect(body.notifications[0]!.id).toMatch(/^[0-9a-f-]{36}$/u);

    const ack = await app.request(`https://app.test/api/desktop/notifications/${body.notifications[0]!.id}/ack`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "displayed", occurredAtEpochMs: NOW }),
    }, environment(store));
    expect(ack.status).toBe(204);
    const empty = await app.request("https://app.test/api/desktop/notifications", { headers }, environment(store));
    await expect(empty.json()).resolves.toEqual({ notifications: [] });
  });
});
