import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { hashAppSessionToken } from "../../../shared/renewal/crypto";
import { MOBILE_SESSION_TTL_MS } from "../src/services/pairing-service";
import { MemoryRenewalStore } from "../../../shared/tests/helpers/memory-renewal-store";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const ENV_SECRET = "test-pairing-secret-that-is-at-least-32-bytes";

afterEach(() => vi.useRealTimers());

function environment(store: MemoryRenewalStore) {
  return {
    DB: {} as D1Database,
    DATA_BUCKET: {} as R2Bucket,
    PAIRING_SECRET: ENV_SECRET,
    RENEWAL_STORE: store,
  };
}

async function setupAccount() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const store = new MemoryRenewalStore();
  const env = environment(store);
  const enrolled = await app.request("https://app.test/api/desktop/installations", {
    method: "POST",
    headers: { origin: "https://app.test", "content-type": "application/json" },
    body: JSON.stringify({ installationId: "desktop-installation-1" }),
  }, env);
  const { accessToken } = await enrolled.json<{ accessToken: string }>();
  const userId = store.desktops.get("desktop-installation-1")!.userId;
  const mobileToken = `jbs_${"6".repeat(64)}`;
  store.sessions.set("mobile-session", {
    id: "mobile-session", userId, installationId: `jbmi_${"6".repeat(32)}`,
    kind: "mobile", label: "내 휴대폰", tokenSha256: await hashAppSessionToken(mobileToken),
    createdAtEpochMs: NOW, expiresAtEpochMs: NOW + MOBILE_SESSION_TTL_MS,
    lastSeenAtEpochMs: NOW, revokedAtEpochMs: null, sourcePairingId: null,
  });
  return {
    store,
    env,
    desktopHeaders: { authorization: `Bearer ${accessToken}`, origin: "https://app.test" },
    mobileHeaders: { cookie: `jb_device=${mobileToken}`, origin: "https://app.test" },
  };
}

describe("shared personal controls", () => {
  it("shares canonical meal and attendance preferences across desktop and mobile", async () => {
    const fixture = await setupAccount();
    const get = (role: "desktop" | "mobile", resource: string) => app.request(
      `https://app.test/api/${role}/${resource}`,
      { headers: role === "desktop" ? fixture.desktopHeaders : fixture.mobileHeaders }, fixture.env,
    );
    await expect((await get("desktop", "meal-preferences")).json()).resolves.toEqual({
      enabled: false, breakfast: false, lunch: false, dinner: false, updatedAtEpochMs: 0,
    });
    await expect((await get("mobile", "v2/attendance/preferences")).json()).resolves.toEqual({
      enabled: true, morning: true, evening: true,
      morningStartHour: 9, eveningEndHour: 4,
      morningIntervalMinutes: 15, eveningIntervalMinutes: 15,
      skipSunday: false, skipAttendanceDate: null,
    });

    const meal = await app.request("https://app.test/api/desktop/meal-preferences", {
      method: "PUT", headers: { ...fixture.desktopHeaders, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, breakfast: false, lunch: true, dinner: true }),
    }, fixture.env);
    expect(meal.status).toBe(200);
    await expect(meal.json()).resolves.toEqual({
      enabled: true, breakfast: false, lunch: true, dinner: true, updatedAtEpochMs: NOW,
    });
    await expect((await get("mobile", "meal-preferences")).json()).resolves.toEqual({
      enabled: true, breakfast: false, lunch: true, dinner: true, updatedAtEpochMs: NOW,
    });

    const attendance = await app.request("https://app.test/api/mobile/v2/attendance/preferences", {
      method: "PUT", headers: { ...fixture.mobileHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true, morning: false, evening: true,
        morningStartHour: 6, eveningEndHour: 2,
        morningIntervalMinutes: 5, eveningIntervalMinutes: 10,
        skipSunday: true, skipAttendanceDate: "2026-08-03",
      }),
    }, fixture.env);
    expect(attendance.status).toBe(200);
    await expect(attendance.json()).resolves.toEqual({
      enabled: true, morning: false, evening: true,
      morningStartHour: 6, eveningEndHour: 2,
      morningIntervalMinutes: 5, eveningIntervalMinutes: 10,
      skipSunday: true, skipAttendanceDate: "2026-08-03",
    });
    await expect((await get("desktop", "v2/attendance/preferences")).json()).resolves.toEqual({
      enabled: true, morning: false, evening: true,
      morningStartHour: 6, eveningEndHour: 2,
      morningIntervalMinutes: 5, eveningIntervalMinutes: 10,
      skipSunday: true, skipAttendanceDate: "2026-08-03",
    });
  });

  it("keeps the legacy four-field attendance endpoint exact while preserving v2-only fields", async () => {
    const fixture = await setupAccount();
    const request = (role: "desktop" | "mobile", method: "GET" | "PUT", body?: unknown) => app.request(
      `https://app.test/api/${role}/attendance/preferences`,
      {
        method,
        headers: {
          ...(role === "desktop" ? fixture.desktopHeaders : fixture.mobileHeaders),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      fixture.env,
    );

    await expect((await request("desktop", "GET")).json()).resolves.toEqual({
      morning: true, evening: true, skipSunday: false, skipAttendanceDate: null,
    });
    const legacyUpdate = {
      morning: false, evening: true, skipSunday: true, skipAttendanceDate: "2026-08-03",
    };
    await expect((await request("mobile", "PUT", legacyUpdate)).json()).resolves.toEqual(legacyUpdate);
    await expect((await app.request("https://app.test/api/desktop/v2/attendance/preferences", {
      headers: fixture.desktopHeaders,
    }, fixture.env)).json()).resolves.toEqual({
      enabled: true, ...legacyUpdate,
      morningStartHour: 9, eveningEndHour: 4,
      morningIntervalMinutes: 15, eveningIntervalMinutes: 15,
    });

    const v2Update = {
      enabled: false, morning: true, evening: false,
      morningStartHour: 4, eveningEndHour: 0,
      morningIntervalMinutes: 3, eveningIntervalMinutes: 30,
      skipSunday: false, skipAttendanceDate: null,
    };
    const v2Response = await app.request("https://app.test/api/desktop/v2/attendance/preferences", {
      method: "PUT",
      headers: { ...fixture.desktopHeaders, "content-type": "application/json" },
      body: JSON.stringify(v2Update),
    }, fixture.env);
    expect(v2Response.status).toBe(200);
    await expect((await request("mobile", "GET")).json()).resolves.toEqual({
      morning: true, evening: false, skipSunday: false, skipAttendanceDate: null,
    });
    await expect((await request("desktop", "PUT", legacyUpdate)).json()).resolves.toEqual(legacyUpdate);
    await expect((await app.request("https://app.test/api/mobile/v2/attendance/preferences", {
      headers: fixture.mobileHeaders,
    }, fixture.env)).json()).resolves.toEqual({
      ...v2Update,
      morning: false,
      evening: true,
      skipSunday: true,
      skipAttendanceDate: "2026-08-03",
    });

    expect((await request("desktop", "PUT", { ...legacyUpdate, enabled: true })).status).toBe(400);
    expect((await app.request("https://app.test/api/desktop/v2/attendance/preferences", {
      method: "PUT",
      headers: { ...fixture.desktopHeaders, "content-type": "application/json" },
      body: JSON.stringify(legacyUpdate),
    }, fixture.env)).status).toBe(400);
  });

  it.each([
    { morningStartHour: 3 },
    { morningStartHour: 10 },
    { eveningEndHour: -1 },
    { eveningEndHour: 5 },
    { morningIntervalMinutes: 2 },
    { eveningIntervalMinutes: 60 },
  ])("rejects an invalid attendance schedule: $morningStartHour/$eveningEndHour/$morningIntervalMinutes/$eveningIntervalMinutes", async (override) => {
    const fixture = await setupAccount();
    const response = await app.request("https://app.test/api/desktop/v2/attendance/preferences", {
      method: "PUT",
      headers: { ...fixture.desktopHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true, morning: true, evening: true,
        morningStartHour: 9, eveningEndHour: 4,
        morningIntervalMinutes: 15, eveningIntervalMinutes: 15,
        skipSunday: false, skipAttendanceDate: null,
        ...override,
      }),
    }, fixture.env);
    expect(response.status).toBe(400);
  });

  it("shares strict laundry watches and rejects deterministic active duplicates", async () => {
    const fixture = await setupAccount();
    const body = {
      machineId: "tower-3", appliance: "washer", sessionId: "session-1",
      notifyBeforeMinutes: 10, notifyWhenAvailable: true,
    };
    const create = (payload: unknown) => app.request("https://app.test/api/desktop/laundry-watches", {
      method: "POST", headers: { ...fixture.desktopHeaders, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, fixture.env);
    const created = await create(body);
    expect(created.status).toBe(201);
    const watch = await created.json<{ id: string }>();
    expect(watch.id).toMatch(/^jbw_[a-f0-9]{64}$/u);
    expect(watch).toMatchObject({ ...body, status: "active", createdAtEpochMs: NOW, updatedAtEpochMs: NOW });
    expect((await create({ ...body, notifyBeforeMinutes: 20 })).status).toBe(409);
    expect((await create({ ...body, unexpected: true })).status).toBe(400);

    const mobileList = await app.request("https://app.test/api/mobile/laundry-watches", {
      headers: fixture.mobileHeaders,
    }, fixture.env);
    await expect(mobileList.json()).resolves.toMatchObject({ watches: [{ id: watch.id, status: "active" }] });
    const cancelled = await app.request(`https://app.test/api/mobile/laundry-watches/${watch.id}`, {
      method: "DELETE", headers: fixture.mobileHeaders,
    }, fixture.env);
    expect(cancelled.status).toBe(204);
    expect((await app.request(`https://app.test/api/mobile/laundry-watches/${watch.id}`, {
      method: "DELETE", headers: fixture.mobileHeaders,
    }, fixture.env)).status).toBe(404);
  });

  it("shares a best-effort FIFO laundry queue without exposing reservation claims", async () => {
    const fixture = await setupAccount();
    const create = (payload: unknown) => app.request("https://app.test/api/mobile/laundry-queue", {
      method: "POST", headers: { ...fixture.mobileHeaders, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, fixture.env);
    const created = await create({ machineId: null, appliance: "dryer" });
    expect(created.status).toBe(201);
    const entry = await created.json<{ id: string }>();
    expect(entry.id).toMatch(/^jbq_[a-f0-9]{64}$/u);
    expect(entry).toEqual({
      id: entry.id, machineId: null, appliance: "dryer", status: "waiting",
      joinedAtEpochMs: NOW, leftAtEpochMs: null, position: 1,
    });
    expect((await create({ machineId: null, appliance: "dryer" })).status).toBe(409);
    expect((await create({ machineId: null, appliance: "dryer", reserve: true })).status).toBe(400);

    const desktopList = await app.request("https://app.test/api/desktop/laundry-queue", {
      headers: fixture.desktopHeaders,
    }, fixture.env);
    const body = await desktopList.json<Record<string, unknown>>();
    expect(body).toEqual({ entries: [entry] });
    expect(JSON.stringify(body)).not.toContain("claimExpiresAt");
    expect(JSON.stringify(body)).not.toContain("reservation");
    expect((await app.request(`https://app.test/api/desktop/laundry-queue/${entry.id}`, {
      method: "DELETE", headers: fixture.desktopHeaders,
    }, fixture.env)).status).toBe(204);
  });
});
