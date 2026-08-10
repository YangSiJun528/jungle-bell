import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/workers/api";
import { DESKTOP_SESSION_TTL_MS, MOBILE_SESSION_TTL_MS, PAIRING_TTL_MS } from "../src/renewal/service";
import { planAttendanceNotifications } from "../src/renewal/notification-planner";
import { sha256Hex } from "../src/renewal/crypto";
import { MemoryRenewalStore } from "./helpers/memory-renewal-store";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const SECRET = "test-pairing-secret-that-is-at-least-32-bytes";

afterEach(() => vi.useRealTimers());

function cookie(value = "credential-that-must-never-be-persisted") {
  return {
    name: "access_token",
    value,
    domain: "jungle-lms.krafton.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  } as const;
}

function environment(store: MemoryRenewalStore, subject = "immutable-lms-id-42") {
  return {
    DB: {} as D1Database,
    DATA_BUCKET: {} as R2Bucket,
    PAIRING_SECRET: SECRET,
    RENEWAL_STORE: store,
    LMS_GATEWAY: { verifyIdentity: vi.fn(async () => ({ authenticated: true, subject })) },
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

async function seedVerifiedDesktop(
  store: MemoryRenewalStore,
  input: { subjectSha256: string; installationId: string; nowEpochMs: number },
): Promise<string> {
  const sessionId = `jbas_${crypto.randomUUID()}`;
  await store.issueVerifiedDesktopSession({
    candidateUserId: crypto.randomUUID(),
    subjectSha256: input.subjectSha256,
    installationId: input.installationId,
    sessionId,
    tokenSha256: await sha256Hex(sessionId),
    nowEpochMs: input.nowEpochMs,
    expiresAtEpochMs: input.nowEpochMs + DESKTOP_SESSION_TTL_MS,
  });
  return store.desktops.get(input.installationId)!.userId;
}

describe("renewal API", () => {
  it("verifies one strict LMS cookie once and persists only subject/token hashes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const credential = cookie();

    const response = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [credential],
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ accessToken: string; expiresAt: string }>();
    expect(body.accessToken).toMatch(/^jba_[a-f0-9]{64}$/);
    expect(env.LMS_GATEWAY.verifyIdentity).toHaveBeenCalledOnce();
    expect(env.LMS_GATEWAY.verifyIdentity).toHaveBeenCalledWith([credential]);
    const persisted = JSON.stringify(store.persistedValues);
    expect(persisted).not.toContain(credential.value);
    expect(persisted).not.toContain("immutable-lms-id-42");
    expect(persisted).not.toContain(body.accessToken);
    expect(persisted).toContain(await sha256Hex("immutable-lms-id-42"));
    expect(persisted).toContain(await sha256Hex(body.accessToken));

    const heartbeat = await jsonRequest(env, "/v1/desktop/heartbeat", {
      lmsSessionState: "connected",
      appVersion: "0.5.0",
      attendanceNotifications: {
        morning: false,
        evening: true,
        skipSunday: true,
        skipAttendanceDate: "2026-08-03",
      },
    }, body.accessToken);
    expect(heartbeat.status).toBe(200);
    const firstUserId = store.desktops.get("desktop-installation-1")!.userId;
    expect(store.preferences.get(firstUserId)).toEqual({
      morning: false,
      evening: true,
      skipSunday: true,
      skipAttendanceDate: "2026-08-03",
    });

    const second = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-2",
      cookies: [cookie("another-short-lived-credential")],
    });
    expect(second.status).toBe(201);
    expect(new Set([...store.desktops.values()].map((device) => device.userId))).toHaveLength(1);
  });

  it("rejects ambiguous or weakly scoped LMS credentials before calling the gateway", async () => {
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const response = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [{ ...cookie(), httpOnly: false }],
    });
    expect(response.status).toBe(400);
    expect(env.LMS_GATEWAY.verifyIdentity).not.toHaveBeenCalled();
  });

  it("atomically replaces concurrent desktop verification for one installation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const firstEnv = environment(store, "lms-user-a");
    const secondEnv = environment(store, "lms-user-b");

    const responses = await Promise.all([
      jsonRequest(firstEnv, "/v1/auth/lms/verify", {
        installationId: "shared-desktop-installation",
        cookies: [cookie("credential-a")],
      }),
      jsonRequest(secondEnv, "/v1/auth/lms/verify", {
        installationId: "shared-desktop-installation",
        cookies: [cookie("credential-b")],
      }),
    ]);
    const tokens = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(201);
      return (await response.json<{ accessToken: string }>()).accessToken;
    }));
    const active = [...store.sessions.values()].filter((session) => session.kind === "desktop" && session.revokedAtEpochMs === null);
    expect(active).toHaveLength(1);
    expect(store.desktops.get("shared-desktop-installation")?.userId).toBe(active[0]!.userId);

    const heartbeatStatuses = await Promise.all(tokens.map(async (token) => (await jsonRequest(firstEnv, "/v1/desktop/heartbeat", {
      lmsSessionState: "connected",
      appVersion: "0.5.0",
    }, token)).status));
    expect(heartbeatStatuses.sort()).toEqual([200, 401]);
  });

  it("rejects a desktop token when its installation is currently owned by another user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const desktop = store.desktops.get("desktop-installation-1")!;
    store.desktops.set(desktop.installationId, { ...desktop, userId: crypto.randomUUID() });

    const response = await app.request("https://app.test/v1/devices", {
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
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();

    const pairingResponse = await jsonRequest(env, "/v1/pairings", {}, accessToken);
    expect(pairingResponse.status).toBe(201);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string; manualCode: string; expiresAt: string }>();
    expect(pairing.manualCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(new URL(pairing.qrPayload).origin).toBe("https://app.test");
    const fragment = new URL(pairing.qrPayload).hash.slice(1);
    const challenge = new URLSearchParams(fragment).get("challenge")!;
    expect(JSON.stringify([...store.pairings.values()])).not.toContain(challenge);
    expect(JSON.stringify([...store.pairings.values()])).not.toContain(pairing.manualCode);

    const claimed = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "내 휴대폰",
      installationId: `jbmi_${"a".repeat(32)}`,
    });
    expect(claimed.status).toBe(201);
    const claim = await claimed.json<{ claimId: string; claimReceipt: string }>();
    const replayClaim = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "공격자",
      installationId: `jbmi_${"b".repeat(32)}`,
    });
    expect(replayClaim.status).toBe(409);

    const approved = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/approve`, {}, accessToken);
    expect(approved.status).toBe(204);
    const completed = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/complete`, {
      claimId: claim.claimId,
      claimReceipt: claim.claimReceipt,
    });
    expect(completed.status).toBe(204);
    const setCookie = completed.headers.get("set-cookie")!;
    expect(setCookie).toContain("__Host-jb_device=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(claim.claimReceipt);
    const mobileCookie = setCookie.split(";", 1)[0]!;

    const mobileProbe = await app.request("https://app.test/v1/mobile/session", {
      headers: { cookie: mobileCookie },
    }, env);
    expect(mobileProbe.status).toBe(200);
    await expect(mobileProbe.json()).resolves.toMatchObject({ authenticated: true });

    const retryComplete = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/complete`, {
      claimId: claim.claimId,
      claimReceipt: claim.claimReceipt,
    });
    expect(retryComplete.status).toBe(204);
    expect(retryComplete.headers.get("set-cookie")).toContain("__Host-jb_device=");

    const mobileSession = [...store.sessions.values()].find((session) => session.kind === "mobile")!;
    expect(mobileSession.expiresAtEpochMs - mobileSession.createdAtEpochMs).toBe(MOBILE_SESSION_TTL_MS);
    const devices = await app.request("https://app.test/v1/devices", {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    expect(await devices.json()).toMatchObject({ devices: [{
      deviceId: mobileSession.id,
      deviceLabel: "내 휴대폰",
      status: "active",
      pushEnabled: false,
    }] });

    const revoked = await app.request(`https://app.test/v1/devices/${mobileSession.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    expect(revoked.status).toBe(204);
    const revokedProbe = await app.request("https://app.test/v1/mobile/session", {
      headers: { cookie: mobileCookie },
    }, env);
    expect(revokedProbe.status).toBe(401);
  });

  it("omits claim details after a claimed pairing expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const pairingResponse = await jsonRequest(env, "/v1/pairings", {}, accessToken);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string }>();
    const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge")!;
    const claimed = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "만료될 휴대폰",
      installationId: `jbmi_${"c".repeat(32)}`,
    });
    expect(claimed.status).toBe(201);

    vi.setSystemTime(NOW + 2 * 60_000 + 1);
    const status = await app.request(`https://app.test/v1/pairings/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ status: "expired", claim: null });
  });

  it("lets an approved mobile finish after the original pairing TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    const pairingResponse = await jsonRequest(env, "/v1/pairings", {}, accessToken);
    const pairing = await pairingResponse.json<{ pairingId: string; qrPayload: string }>();
    const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge")!;
    const claimed = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/claims`, {
      challenge,
      deviceLabel: "경계 승인 휴대폰",
      installationId: `jbmi_${"d".repeat(32)}`,
    });
    const claim = await claimed.json<{ claimId: string; claimReceipt: string }>();

    vi.setSystemTime(NOW + PAIRING_TTL_MS - 1);
    const approved = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/approve`, {}, accessToken);
    expect(approved.status).toBe(204);

    vi.setSystemTime(NOW + PAIRING_TTL_MS + 1);
    const approvedStatus = await app.request(`https://app.test/v1/pairings/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    await expect(approvedStatus.json()).resolves.toEqual({ status: "approved", claim: null });

    const completed = await jsonRequest(env, `/v1/pairings/${pairing.pairingId}/complete`, {
      claimId: claim.claimId,
      claimReceipt: claim.claimReceipt,
    });
    expect(completed.status).toBe(204);
    expect(completed.headers.get("set-cookie")).toContain("__Host-jb_device=");

    const completedStatus = await app.request(`https://app.test/v1/pairings/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, env);
    await expect(completedStatus.json()).resolves.toEqual({ status: "completed", claim: null });
  });

  it("accepts only the newest desktop attendance snapshot and rejects future client time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const env = environment(store);
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
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
    const put = (body: unknown) => app.request("https://app.test/v1/attendance/snapshots", {
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
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();
    vi.spyOn(store, "recordDesktopHeartbeat").mockResolvedValue(false);

    const response = await app.request("https://app.test/v1/attendance/snapshots", {
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
    const verified = await jsonRequest(env, "/v1/auth/lms/verify", {
      installationId: "desktop-installation-1",
      cookies: [cookie()],
    });
    const { accessToken } = await verified.json<{ accessToken: string }>();

    const read = () => app.request("https://app.test/v1/attendance/snapshot", {
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

  it("deduplicates offline fallback notifications per attendance slot", async () => {
    const store = new MemoryRenewalStore();
    const now = Date.parse("2026-08-03T00:50:00.000Z");
    const userId = await seedVerifiedDesktop(store, {
      subjectSha256: "a".repeat(64), installationId: "desktop-installation-1", nowEpochMs: now - 10 * 60_000,
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
      const userId = await seedVerifiedDesktop(store, {
        subjectSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"),
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
    const userId = await seedVerifiedDesktop(store, {
      subjectSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"),
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
    const publicPreflight = await app.request("https://app.test/v1/meals", {
      method: "OPTIONS",
      headers: { origin: "https://other.example", "access-control-request-method": "GET" },
    }, env);
    expect(publicPreflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(publicPreflight.headers.get("access-control-allow-credentials")).toBeNull();

    const privatePreflight = await app.request("https://app.test/v1/devices", {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "GET" },
    }, env);
    expect(privatePreflight.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(privatePreflight.headers.get("access-control-allow-credentials")).toBe("true");

    const rejected = await app.request("https://app.test/v1/desktop/heartbeat", {
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

  it("does not advertise or persist Web Push when the relay is not fully configured", async () => {
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
      tokenSha256: await sha256Hex(mobileToken),
      createdAtEpochMs: NOW,
      expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW,
      revokedAtEpochMs: null,
      sourcePairingId: null,
    });
    const baseEnv = environment(store);
    const headers = { cookie: `jb_device=${mobileToken}`, origin: "https://app.test" };

    const missingRelay = await app.request("https://app.test/v1/push/vapid-public-key", { headers }, {
      ...baseEnv,
      VAPID_PUBLIC_KEY: "public-vapid-key",
    });
    expect(missingRelay.status).toBe(503);

    const registration = await app.request("https://app.test/v1/push/subscriptions", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/device",
        keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
      }),
    }, { ...baseEnv, VAPID_PUBLIC_KEY: "public-vapid-key" });
    expect(registration.status).toBe(503);
    expect(store.subscriptions.size).toBe(0);

    const configured = await app.request("https://app.test/v1/push/vapid-public-key", { headers }, {
      ...baseEnv,
      VAPID_PUBLIC_KEY: "public-vapid-key",
      WEB_PUSH_RELAY: { fetch: vi.fn() },
    });
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toEqual({ publicKey: "public-vapid-key" });
  });

  it("sends a rate-limited authenticated test push only to the current mobile session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const mobileToken = `jbs_${"e".repeat(64)}`;
    store.sessions.set("mobile-session", {
      id: "mobile-session", userId: "user-1", installationId: `jbmi_${"f".repeat(32)}`,
      kind: "mobile", label: "내 휴대폰", tokenSha256: await sha256Hex(mobileToken),
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
    let relayRequest: RequestInit | undefined;
    const relay = { fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      relayRequest = init;
      return new Response(null, { status: 204 });
    }) };
    const env = {
      ...environment(store),
      VAPID_PUBLIC_KEY: "public-vapid-key",
      WEB_PUSH_RELAY: relay,
    };
    const request = () => app.request("https://app.test/v1/notifications/test", {
      method: "POST",
      headers: { cookie: `jb_device=${mobileToken}`, origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({}),
    }, env);

    const response = await request();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ queued: 2 });
    expect(relay.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(relayRequest?.body))).toMatchObject({
      payload: { kind: "test", path: "/dashboard.html#notifications" },
    });
    expect(await request()).toHaveProperty("status", 429);
  });

  it("broadcasts a desktop test notification to every connected mobile and suppresses a duplicate PC poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const desktopToken = `jba_${"2".repeat(64)}`;
    store.sessions.set("desktop-session", {
      id: "desktop-session", userId: "user-1", installationId: "desktop-installation-1",
      kind: "desktop", label: "PC", tokenSha256: await sha256Hex(desktopToken),
      createdAtEpochMs: NOW, expiresAtEpochMs: NOW + DESKTOP_SESSION_TTL_MS,
      lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
    });
    store.desktops.set("desktop-installation-1", {
      installationId: "desktop-installation-1", userId: "user-1", lastSeenAtEpochMs: NOW,
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
    const relay = { fetch: vi.fn(async () => new Response(null, { status: 204 })) };
    const response = await app.request("https://app.test/v1/notifications/test", {
      method: "POST",
      headers: { authorization: `Bearer ${desktopToken}`, origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({ desktopDelivered: true }),
    }, { ...environment(store), VAPID_PUBLIC_KEY: "public-vapid-key", WEB_PUSH_RELAY: relay });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ queued: 2 });
    expect(relay.fetch).toHaveBeenCalledTimes(2);
    expect([...store.notifications.values()][0]?.displayedAt).toBe(NOW);
    await expect(store.listDesktopInbox("user-1", NOW, 20)).resolves.toHaveLength(0);
  });
});
