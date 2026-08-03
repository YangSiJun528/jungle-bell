import { describe, expect, it, vi } from "vitest";

import { buildApp, type BuildAppOptions } from "./app.js";
import {
  SqliteCampusUserRepository,
} from "./campus/repository.js";
import {
  SqliteAttendanceSnapshotStore,
  SqliteClaimTransportStore,
  SqliteDesktopIdentityStore,
  SqliteDesktopSessionStore,
  SqlitePairingStore,
  SqlitePushSubscriptionStore,
  openSqliteDatabase,
} from "./infra/sqlite/index.js";
import {
  NotificationService,
  ServerNotificationPlanner,
  SqliteNotificationRepository,
  StoreBackedNotificationTargetDirectory,
} from "./notifications/index.js";
import { computeLmsSubjectBinding } from "./lms/subject-binding.js";

const LOOPBACK_ORIGIN = "http://127.0.0.1:5173";

describe("platform API integrated services", () => {
  it("serves campus data and keeps personal settings shared by desktop and paired mobile", async () => {
    const history = vi.fn(async () => ({
      posts: [],
      nextBefore: null,
    }));
    const fixture = await createFixture({
      campusCollector: {
        getLatest(kind) {
          return {
            kind,
            data: null,
            etag: null,
            savedAtEpochMs: null,
            lastCheckedAtEpochMs: null,
            stale: true,
            lastError: null,
          };
        },
        getMealHistory: history,
      } satisfies NonNullable<BuildAppOptions["campusCollector"]>,
    });
    const desktopCookie = await bootstrapDesktop(fixture.app);

    const laundry = await fixture.app.inject({
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
      lastError: null,
    });
    const mealHistory = await fixture.app.inject({
      method: "GET",
      url: "/api/public/campus/meals/history?before=cursor-1&limit=5",
    });
    expect(mealHistory.statusCode).toBe(200);
    expect(mealHistory.json()).toEqual({ posts: [], nextBefore: null });
    expect(history).toHaveBeenCalledWith({
      before: "cursor-1",
      limit: 5,
    });

    const initialRule = await fixture.app.inject({
      method: "GET",
      url: "/api/private/meal-rule",
      headers: { cookie: desktopCookie },
    });
    expect(initialRule.json()).toEqual({
      enabled: false,
      breakfast: false,
      lunch: false,
      dinner: false,
      updatedAtEpochMs: 0,
    });
    const updatedRule = await fixture.app.inject({
      method: "PUT",
      url: "/api/private/meal-rule",
      headers: mutationHeaders(desktopCookie),
      payload: {
        enabled: true,
        breakfast: false,
        lunch: true,
        dinner: true,
      },
    });
    expect(updatedRule.statusCode).toBe(200);
    expect(updatedRule.json()).toMatchObject({
      enabled: true,
      lunch: true,
      dinner: true,
    });
    const defaultAttendanceRule = await fixture.app.inject({
      method: "GET",
      url: "/api/private/attendance-rule",
      headers: { cookie: desktopCookie },
    });
    expect(defaultAttendanceRule.json()).toEqual({
      enabled: false,
      morning: false,
      evening: false,
      updatedAtEpochMs: 0,
    });
    const updatedAttendanceRule = await fixture.app.inject({
      method: "PUT",
      url: "/api/private/attendance-rule",
      headers: mutationHeaders(desktopCookie),
      payload: {
        enabled: true,
        morning: true,
        evening: false,
      },
    });
    expect(updatedAttendanceRule.statusCode).toBe(200);
    expect(updatedAttendanceRule.json()).toMatchObject({
      enabled: true,
      morning: true,
      evening: false,
    });

    const watch = await fixture.app.inject({
      method: "POST",
      url: "/api/private/laundry-watches",
      headers: mutationHeaders(desktopCookie),
      payload: {
        machineId: "tower-3",
        appliance: "washer",
        sessionId: "session-1",
        notifyBeforeMinutes: 10,
        notifyWhenAvailable: true,
      },
    });
    expect(watch.statusCode).toBe(201);
    expect(watch.json()).toMatchObject({
      machineId: "tower-3",
      appliance: "washer",
      status: "active",
    });
    const duplicateWatch = await fixture.app.inject({
      method: "POST",
      url: "/api/private/laundry-watches",
      headers: mutationHeaders(desktopCookie),
      payload: {
        machineId: "tower-3",
        appliance: "washer",
        sessionId: "session-1",
        notifyBeforeMinutes: 20,
        notifyWhenAvailable: true,
      },
    });
    expect(duplicateWatch.statusCode).toBe(409);
    expect(duplicateWatch.json()).toEqual({
      error: "LAUNDRY_WATCH_ALREADY_EXISTS",
    });

    const queue = await fixture.app.inject({
      method: "POST",
      url: "/api/private/laundry-queue",
      headers: mutationHeaders(desktopCookie),
      payload: { machineId: "tower-3", appliance: "washer" },
    });
    expect(queue.statusCode).toBe(201);
    expect(queue.json()).toMatchObject({
      machineId: "tower-3",
      status: "waiting",
      position: 1,
    });
    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/api/private/laundry-queue",
      headers: mutationHeaders(desktopCookie),
      payload: { machineId: "tower-3", appliance: "washer" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: "LAUNDRY_QUEUE_ALREADY_JOINED",
    });

    const mobileCookie = await pairMobile(fixture.app, desktopCookie);
    const mobileRule = await fixture.app.inject({
      method: "GET",
      url: "/api/private/meal-rule",
      headers: { cookie: mobileCookie },
    });
    expect(mobileRule.statusCode).toBe(200);
    expect(mobileRule.json()).toEqual(updatedRule.json());
    const mobileAttendanceRule = await fixture.app.inject({
      method: "GET",
      url: "/api/private/attendance-rule",
      headers: { cookie: mobileCookie },
    });
    expect(mobileAttendanceRule.json()).toEqual(
      updatedAttendanceRule.json(),
    );
    const mobileWatches = await fixture.app.inject({
      method: "GET",
      url: "/api/private/laundry-watches",
      headers: { cookie: mobileCookie },
    });
    expect(mobileWatches.json()).toMatchObject({
      watches: [{ id: watch.json().id, status: "active" }],
    });
    const mobileQueue = await fixture.app.inject({
      method: "GET",
      url: "/api/private/laundry-queue",
      headers: { cookie: mobileCookie },
    });
    expect(mobileQueue.json()).toMatchObject({
      entries: [{ id: queue.json().id, position: 1 }],
    });
    const repeatedPairing = await fixture.app.inject({
      method: "POST",
      url: "/api/pairings",
      headers: mutationHeaders(desktopCookie),
    });
    expect(repeatedPairing.statusCode).toBe(201);
    expect(repeatedPairing.json()).toMatchObject({
      pairingId: expect.stringMatching(/^jbc_[0-9a-f]{32}$/u),
    });

    expect(
      (
        await fixture.app.inject({
          method: "DELETE",
          url: `/api/private/laundry-watches/${watch.json().id}`,
          headers: mutationHeaders(mobileCookie),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await fixture.app.inject({
          method: "DELETE",
          url: `/api/private/laundry-queue/${queue.json().id}`,
          headers: mutationHeaders(mobileCookie),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/private/notification-preferences",
          headers: { cookie: mobileCookie },
        })
      ).statusCode,
    ).toBe(404);

    await fixture.close();
  });

  it("returns recent claimed and expired queue outcomes with no active position", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const queued = await fixture.app.inject({
      method: "POST",
      url: "/api/private/laundry-queue",
      headers: mutationHeaders(desktopCookie),
      payload: {
        machineId: "tower-recent-outcome",
        appliance: "washer",
      },
    });
    expect(queued.statusCode).toBe(201);
    expect(queued.json()).toMatchObject({
      status: "waiting",
      position: 1,
    });

    const claimedAtEpochMs = Date.now();
    expect(
      fixture.campusUsers.claimWaitingQueueHead({
        machineId: "tower-recent-outcome",
        appliance: "washer",
        claimedAtEpochMs,
        expiresAtEpochMs: claimedAtEpochMs + 1,
      }),
    ).toMatchObject({ id: queued.json().id, status: "claimed" });
    const claimed = await fixture.app.inject({
      method: "GET",
      url: "/api/private/laundry-queue",
      headers: { cookie: desktopCookie },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      entries: [
        {
          id: queued.json().id,
          status: "claimed",
          position: null,
        },
      ],
    });

    expect(
      fixture.campusUsers.expireQueueClaims(claimedAtEpochMs + 1),
    ).toBe(1);
    const expired = await fixture.app.inject({
      method: "GET",
      url: "/api/private/laundry-queue",
      headers: { cookie: desktopCookie },
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toMatchObject({
      entries: [
        {
          id: queued.json().id,
          status: "expired",
          position: null,
        },
      ],
    });

    await fixture.close();
  });

  it("fans eligible events into the durable desktop inbox and accepts native acknowledgements", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    fixture.notifications.record({
      kind: "login-required",
      sourceEventId: "login-required-integration",
      userId: "demo-user",
      desktopDeviceId: "demo-desktop",
      reason: "expired",
      occurredAtEpochMs: Date.now(),
    });
    expect(await fixture.notifications.runDue()).toMatchObject({
      fannedOut: 1,
    });

    const inbox = await fixture.app.inject({
      method: "GET",
      url: "/api/private/desktop/notifications?limit=20",
      headers: { cookie: desktopCookie },
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toMatchObject({
      notifications: [
        {
          kind: "login-required",
          title: "LMS 로그인이 필요합니다",
          path: "/app#attendance",
          attempt: 1,
        },
      ],
    });
    const [notification] = inbox.json().notifications as Array<{
      deliveryId: string;
    }>;
    const ack = await fixture.app.inject({
      method: "POST",
      url:
        `/api/private/desktop/notifications/` +
        `${notification!.deliveryId}/ack`,
      headers: { cookie: desktopCookie },
      payload: {
        outcome: "displayed",
        occurredAtEpochMs: Date.now(),
      },
    });
    expect(ack.statusCode).toBe(204);
    const empty = await fixture.app.inject({
      method: "GET",
      url: "/api/private/desktop/notifications",
      headers: { cookie: desktopCookie },
    });
    expect(empty.json()).toEqual({ notifications: [] });

    await fixture.close();
  });

  it("preserves the durable desktop inbox across an offline reconnect", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const makeDeviceStale = () => {
      const registeredAtEpochMs = Date.now() - 20 * 60 * 1000;
      fixture.database
        .prepare(`
          UPDATE desktop_devices
          SET registered_at_epoch_ms = ?,
              last_verified_at_epoch_ms = ?,
              last_seen_at_epoch_ms = ?
          WHERE user_id = ? AND desktop_device_id = ?
        `)
        .run(
          registeredAtEpochMs,
          registeredAtEpochMs,
          Date.now() - 10 * 60 * 1000,
          "demo-user",
          "demo-desktop",
        );
    };
    const enqueueLoginRequired = async (sourceEventId: string) => {
      fixture.notifications.record({
        kind: "login-required",
        sourceEventId,
        userId: "demo-user",
        desktopDeviceId: "demo-desktop",
        reason: "expired",
        occurredAtEpochMs: Date.now(),
      });
      expect(await fixture.notifications.runDue()).toMatchObject({
        fannedOut: 1,
      });
    };

    await enqueueLoginRequired("offline-before-heartbeat");
    makeDeviceStale();
    const heartbeat = await fixture.app.inject({
      method: "POST",
      url: "/api/private/desktop/heartbeat",
      headers: { cookie: desktopCookie },
      payload: {
        lmsSessionState: "connected",
        appVersion: "0.2.0",
      },
    });
    expect(heartbeat.statusCode).toBe(200);
    const afterHeartbeat = await fixture.app.inject({
      method: "GET",
      url: "/api/private/desktop/notifications",
      headers: { cookie: desktopCookie },
    });
    expect(afterHeartbeat.json().notifications).toHaveLength(1);

    const [first] = afterHeartbeat.json().notifications as Array<{
      deliveryId: string;
    }>;
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url:
            `/api/private/desktop/notifications/` +
            `${first!.deliveryId}/ack`,
          headers: { cookie: desktopCookie },
          payload: {
            outcome: "displayed",
            occurredAtEpochMs: Date.now(),
          },
        })
      ).statusCode,
    ).toBe(204);

    await enqueueLoginRequired("offline-before-inbox");
    makeDeviceStale();
    const afterInboxReconnect = await fixture.app.inject({
      method: "GET",
      url: "/api/private/desktop/notifications",
      headers: { cookie: desktopCookie },
    });
    expect(afterInboxReconnect.statusCode).toBe(200);
    expect(afterInboxReconnect.json().notifications).toHaveLength(1);
    expect(
      fixture.database
        .prepare(`
          SELECT last_seen_at_epoch_ms
          FROM desktop_devices
          WHERE user_id = ? AND desktop_device_id = ?
        `)
        .get("demo-user", "demo-desktop"),
    ).toEqual({
      last_seen_at_epoch_ms: expect.any(Number),
    });

    await fixture.close();
  });

  it("allows a 200-PC startup burst on both desktop ingestion routes", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const heartbeatStatuses = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        fixture.app
          .inject({
            method: "POST",
            url: "/api/private/desktop/heartbeat",
            headers: { cookie: desktopCookie },
            payload: {
              lmsSessionState: "connected",
              appVersion: `0.1.${index % 10}`,
            },
          })
          .then((response) => response.statusCode),
      ),
    );
    expect(new Set(heartbeatStatuses)).toEqual(new Set([200]));

    const collectedAt = new Date().toISOString();
    const attendanceStatuses = await Promise.all(
      Array.from({ length: 200 }, () =>
        fixture.app
          .inject({
            method: "POST",
            url: "/api/private/desktop/attendance-snapshot",
            headers: { cookie: desktopCookie },
            payload: {
              attendanceDate: "2026-07-31",
              cohortId: "cohort-1",
              cohortStatus: "active",
              cohortStartDate: "2026-07-01",
              cohortEndDate: "2026-08-01",
              morningChecked: true,
              eveningChecked: false,
              collectedAt,
            },
          })
          .then((response) => response.statusCode),
      ),
    );
    expect(new Set(attendanceStatuses)).toEqual(new Set([200]));

    await fixture.close();
  });

  it("allows a 200-user campus NAT burst for QR creation and manual-code claims", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const created = await Promise.all(
      Array.from({ length: 200 }, () =>
        fixture.app.inject({
          method: "POST",
          url: "/api/pairings",
          headers: mutationHeaders(desktopCookie),
        }),
      ),
    );
    expect(new Set(created.map((response) => response.statusCode))).toEqual(
      new Set([201]),
    );
    const claims = await Promise.all(
      created.map((response, index) => {
        const pairing = response.json<{
          pairingId: string;
          manualCode: string;
        }>();
        expect(pairing.manualCode).toMatch(
          /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/u,
        );
        return fixture.app.inject({
          method: "POST",
          url: "/api/pairing-claims",
          headers: mutationHeaders(),
          payload: {
            manualCode: pairing.manualCode,
            deviceLabel: `NAT phone ${index}`,
            installationId: `jbmi_${index
              .toString(16)
              .padStart(32, "0")}`,
          },
        });
      }),
    );
    expect(new Set(claims.map((response) => response.statusCode))).toEqual(
      new Set([201]),
    );
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM pairing_challenges WHERE manual_code_hash IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 200 });
    expect(
      JSON.stringify(
        fixture.database
          .prepare(
            "SELECT manual_code_hash FROM pairing_challenges LIMIT 1",
          )
          .get(),
      ),
    ).not.toContain(created[0]!.json().manualCode);

    await fixture.close();
  });

  it("lists and revokes companion sessions together with their Push subscription", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const mobileCookie = await pairMobile(
      fixture.app,
      desktopCookie,
      `jbmi_${"4".repeat(32)}`,
    );
    const subscribed = await fixture.app.inject({
      method: "PUT",
      url: "/api/push/subscriptions",
      headers: mutationHeaders(mobileCookie),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/mobile-session-test",
        expirationTime: null,
        keys: {
          auth: "a".repeat(24),
          p256dh: "b".repeat(48),
        },
      },
    });
    expect(subscribed.statusCode).toBe(201);
    const [pushSubscription] =
      await fixture.pushSubscriptions.listActiveByUserId("demo-user");
    expect(pushSubscription).toBeDefined();
    const createdAtEpochMs = Date.now();
    fixture.notificationRepository.enqueueIntent(
      {
        userId: "demo-user",
        kind: "meal-published",
        sourceEventId: "revoke-pending-push",
        dedupeKey: "revoke-pending-push",
        content: {
          title: "급식",
          body: "메뉴가 등록되었습니다.",
          path: "/app#meals",
        },
        metadata: {},
        targetDeviceId: null,
        occurredAtEpochMs: createdAtEpochMs,
        expiresAtEpochMs: createdAtEpochMs + 60_000,
      },
      createdAtEpochMs,
    );
    const [outbox] = fixture.notificationRepository.claimOutbox(
      createdAtEpochMs,
      1,
      30_000,
    );
    expect(outbox).toBeDefined();
    fixture.notificationRepository.createDeliveries(
      outbox!.event,
      [
        {
          userId: "demo-user",
          deviceId: pushSubscription!.deviceId,
          channel: "web-push",
          destinationId: pushSubscription!.id,
          enabled: true,
        },
      ],
      createdAtEpochMs,
    );
    fixture.notificationRepository.completeOutbox(
      outbox!.event.id,
      createdAtEpochMs,
    );
    const listed = await fixture.app.inject({
      method: "GET",
      url: "/api/private/desktop/mobile-sessions",
      headers: { cookie: desktopCookie },
    });
    expect(listed.statusCode).toBe(200);
    const [session] = listed.json().sessions as Array<{
      sessionId: string;
      status: string;
      lastSeenAt: string;
      pushEnabled: boolean;
    }>;
    expect(session).toMatchObject({
      status: "active",
      lastSeenAt: expect.any(String),
      pushEnabled: true,
    });

    const revoked = await fixture.app.inject({
      method: "DELETE",
      url: `/api/private/desktop/mobile-sessions/${session!.sessionId}`,
      headers: mutationHeaders(desktopCookie),
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/private/dashboard",
          headers: { cookie: mobileCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await fixture.pushSubscriptions.listActiveByUserId("demo-user"),
    ).toEqual([]);
    expect(
      fixture.database
        .prepare(`
          SELECT status, last_error_code
          FROM notification_deliveries
          WHERE event_id = ?
        `)
        .get(outbox!.event.id),
    ).toEqual({
      status: "cancelled",
      last_error_code: "DEVICE_REVOKED",
    });
    const after = await fixture.app.inject({
      method: "GET",
      url: "/api/private/desktop/mobile-sessions",
      headers: { cookie: desktopCookie },
    });
    expect(after.json()).toMatchObject({
      sessions: [
        {
          sessionId: session!.sessionId,
          status: "revoked",
          pushEnabled: false,
        },
      ],
    });

    await fixture.close();
  });

  it("lets a mobile session revoke itself and clears its cookie", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const mobileCookie = await pairMobile(
      fixture.app,
      desktopCookie,
      `jbmi_${"5".repeat(32)}`,
    );
    const logout = await fixture.app.inject({
      method: "DELETE",
      url: "/api/private/mobile/session",
      headers: mutationHeaders(mobileCookie),
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toEqual(
      expect.stringContaining("jb_device=;"),
    );
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/private/dashboard",
          headers: { cookie: mobileCookie },
        })
      ).statusCode,
    ).toBe(401);
    await fixture.close();
  });

  it("rate-limits Push registration per authenticated mobile session instead of a shared NAT address", async () => {
    const fixture = await createFixture();
    const desktopCookie = await bootstrapDesktop(fixture.app);
    const mobileCookies: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      mobileCookies.push(
        await pairMobile(
          fixture.app,
          desktopCookie,
          `jbmi_${index.toString(16).padStart(32, "0")}`,
        ),
      );
    }

    const responses = await Promise.all(
      mobileCookies.map((mobileCookie, index) =>
        fixture.app.inject({
          method: "PUT",
          url: "/api/push/subscriptions",
          headers: mutationHeaders(mobileCookie),
          payload: {
            endpoint:
              `https://fcm.googleapis.com/fcm/send/shared-nat-${index}`,
            expirationTime: null,
            keys: {
              auth: "a".repeat(24),
              p256dh: "b".repeat(48),
            },
          },
        }),
      ),
    );

    expect(new Set(responses.map(({ statusCode }) => statusCode))).toEqual(
      new Set([201]),
    );
    expect(
      await fixture.pushSubscriptions.listActiveByUserId("demo-user"),
    ).toHaveLength(200);
    await fixture.close();
  }, 30_000);

  it("revokes the previous account when the same PWA installation pairs again without its cookie", async () => {
    const fixture = await createFixture({
      lmsGateway: {
        async verifyIdentity(cookies) {
          return {
            authenticated: true,
            subject: cookies[0]?.value ?? null,
          };
        },
      },
    });
    const desktopA = await onboardDesktop(
      fixture.app,
      "desktop-account-a",
      "account-a-access",
    );
    const desktopB = await onboardDesktop(
      fixture.app,
      "desktop-account-b",
      "account-b-access",
    );
    const userA = (
      await fixture.app.inject({
        method: "GET",
        url: "/api/private/desktop/status",
        headers: { cookie: desktopA },
      })
    ).json().user.id as string;
    const userB = (
      await fixture.app.inject({
        method: "GET",
        url: "/api/private/desktop/status",
        headers: { cookie: desktopB },
      })
    ).json().user.id as string;
    expect(userA).not.toBe(userB);
    const installationId = `jbmi_${"6".repeat(32)}`;
    const mobileA = await pairMobile(
      fixture.app,
      desktopA,
      installationId,
    );
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/account-switch",
      expirationTime: null,
      keys: {
        auth: "c".repeat(24),
        p256dh: "d".repeat(48),
      },
    };
    expect(
      (
        await fixture.app.inject({
          method: "PUT",
          url: "/api/push/subscriptions",
          headers: mutationHeaders(mobileA),
          payload: subscription,
        })
      ).statusCode,
    ).toBe(201);

    const mobileB = await pairMobile(
      fixture.app,
      desktopB,
      installationId,
    );
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/private/dashboard",
          headers: { cookie: mobileA },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await fixture.pushSubscriptions.listActiveByUserId(userA),
    ).toEqual([]);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/private/dashboard",
          headers: { cookie: mobileB },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await fixture.app.inject({
          method: "PUT",
          url: "/api/push/subscriptions",
          headers: mutationHeaders(mobileB),
          payload: subscription,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await fixture.pushSubscriptions.listActiveByUserId(userB),
    ).toHaveLength(1);

    await fixture.close();
  });
});

async function createFixture(
  overrides: Partial<BuildAppOptions> = {},
) {
  const database = openSqliteDatabase(":memory:");
  const desktopIdentities = new SqliteDesktopIdentityStore(database);
  const campusUsers = new SqliteCampusUserRepository(database);
  const notificationRepository =
    new SqliteNotificationRepository(database);
  const pushSubscriptions =
    new SqlitePushSubscriptionStore(database);
  const pairingStore = new SqlitePairingStore(database);
  const desktopSessions = new SqliteDesktopSessionStore(database);
  const notifications = new NotificationService({
    planner: new ServerNotificationPlanner(campusUsers),
    repository: notificationRepository,
    targets: new StoreBackedNotificationTargetDirectory({
      desktopIdentities,
      desktopSessions,
      deviceSessions: pairingStore,
      pushSubscriptions,
      webPushEnabled: false,
    }),
    webPush: {
      async deliver() {
        return {
          status: "failed",
          retryable: false,
          errorCode: "DISABLED",
        };
      },
    },
  });
  const app = await buildApp({
    allowDevBootstrap: true,
    attendanceSnapshotStore:
      new SqliteAttendanceSnapshotStore(database),
    campusUserRepository: campusUsers,
    claimTransportStore: new SqliteClaimTransportStore(database),
    desktopIdentityStore: desktopIdentities,
    desktopSessionStore: desktopSessions,
    notificationEventSink: notifications,
    notificationRepository,
    pairingStore,
    pairingApprovalTransportStore: pairingStore,
    pushSubscriptionStore: pushSubscriptions,
    ...overrides,
  });
  return {
    app,
    campusUsers,
    database,
    notifications,
    notificationRepository,
    pushSubscriptions,
    async close() {
      await app.close();
      database.close();
    },
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

async function onboardDesktop(
  app: Awaited<ReturnType<typeof buildApp>>,
  desktopDeviceId: string,
  accessToken: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/onboarding/lms-identity",
    headers: mutationHeaders(),
    payload: {
      desktopDeviceId,
      subjectBinding: computeLmsSubjectBinding(
        desktopDeviceId,
        accessToken,
      ),
      cookies: [
        {
          name: "access_token",
          value: accessToken,
          domain: "jungle-lms.krafton.com",
          path: "/",
          expires: 1_900_000_000,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
    },
  });
  expect(response.statusCode).toBe(204);
  return cookiePair(response.headers["set-cookie"]);
}

async function pairMobile(
  app: Awaited<ReturnType<typeof buildApp>>,
  desktopCookie: string,
  installationId = `jbmi_${"3".repeat(32)}`,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/pairings",
    headers: mutationHeaders(desktopCookie),
  });
  const pairing = created.json<{
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
      deviceLabel: "Integration phone",
      installationId,
    },
  });
  const claim = claimResponse.json<{
    claimId: string;
    claimReceipt: string;
  }>();
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
  const completed = await app.inject({
    method: "POST",
    url: `/api/pairings/${pairing.pairingId}/complete`,
    headers: mutationHeaders(),
    payload: {
      claimId: claim.claimId,
      claimReceipt: claim.claimReceipt,
    },
  });
  expect(completed.statusCode).toBe(204);
  return cookiePair(completed.headers["set-cookie"]);
}

function mutationHeaders(cookie?: string) {
  return {
    origin: LOOPBACK_ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

function cookiePair(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toEqual(expect.any(String));
  return value!.split(";", 1)[0]!;
}
