import { describe, expect, it } from "vitest";

import {
  DEVICE_SESSION_SCOPES,
  NotificationPreferenceService,
  PairingService,
  decodePairingQrPayload,
} from "./domain/index.js";
import {
  CryptoRandomSource,
  Sha256Hasher,
  SystemClock,
} from "./infra/crypto.js";
import {
  SqliteDesktopIdentityStore,
  SqliteNotificationPreferenceStore,
  SqlitePairingStore,
  openSqliteDatabase,
} from "./infra/sqlite/index.js";

const DUMMY_USER_COUNT = 200;

describe("SQLite target-size dummy load", () => {
  it("persists and authenticates 200 concurrent pairing and preference flows", async () => {
    const database = openSqliteDatabase(":memory:");

    try {
      const clock = new SystemClock();
      const pairingStore = new SqlitePairingStore(database);
      const identityStore = new SqliteDesktopIdentityStore(database);
      const pairingService = new PairingService({
        clock,
        random: new CryptoRandomSource(),
        hasher: new Sha256Hasher(),
        store: pairingStore,
        challengeTtlMs: 5 * 60 * 1_000,
        deviceSessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
      });
      const preferenceService = new NotificationPreferenceService({
        clock,
        store: new SqliteNotificationPreferenceStore(database),
      });

      const sessions = await Promise.all(
        Array.from({ length: DUMMY_USER_COUNT }, async (_, index) => {
          const identity = await identityStore.registerVerifiedIdentity({
            candidateUserId: `sqlite-dummy-user-${index}`,
            desktopDeviceId: `sqlite-dummy-desktop-${index}`,
            subjectSha256: index.toString(16).padStart(64, "0"),
            verifiedAtEpochMs: clock.now(),
          });
          const challenge = await pairingService.createChallenge({
            userId: identity.userId,
            desktopDeviceId: identity.desktopDeviceId,
          });
          const payload = decodePairingQrPayload(challenge.qrPayload);
          await pairingService.claimPairing({
            pairingCode: payload.pairingCode,
            deviceLabel: `SQLite dummy phone ${index}`,
            installationId: `jbmi_${index
              .toString(16)
              .padStart(32, "0")}`,
          });
          return pairingService.approvePairing({
            challengeId: challenge.challengeId,
            desktopDeviceId: `sqlite-dummy-desktop-${index}`,
            scopes: DEVICE_SESSION_SCOPES,
          });
        }),
      );

      expect(sessions).toHaveLength(DUMMY_USER_COUNT);
      expect(
        new Set(sessions.map((session) => session.sessionId)).size,
      ).toBe(DUMMY_USER_COUNT);
      expect(
        new Set(sessions.map((session) => session.deviceId)).size,
      ).toBe(DUMMY_USER_COUNT);
      expect(
        new Set(sessions.map((session) => session.sessionToken)).size,
      ).toBe(DUMMY_USER_COUNT);

      const principals = await Promise.all(
        sessions.map((session) =>
          pairingService.authenticateDeviceSession(
            session.sessionToken,
            "notifications:receive",
          ),
        ),
      );
      expect(principals).toHaveLength(DUMMY_USER_COUNT);
      expect(
        new Set(principals.map((principal) => principal.userId)).size,
      ).toBe(DUMMY_USER_COUNT);
      expect(
        new Set(principals.map((principal) => principal.deviceId)).size,
      ).toBe(DUMMY_USER_COUNT);

      const writtenPreferences = await Promise.all(
        sessions.map((session, index) =>
          preferenceService.put({
            userId: `sqlite-dummy-user-${index}`,
            deviceId: session.deviceId,
            meals: {
              breakfast: index % 2 === 0,
              lunch: index % 3 === 0,
              dinner: index % 5 === 0,
            },
            laundry: {
              notifyWhenAvailable: index % 4 !== 0,
              selectedMachineIds: [
                `washer-${index % 10}`,
                `dryer-${index % 5}`,
                `washer-${index % 10}`,
              ],
            },
          }),
        ),
      );
      const readPreferences = await Promise.all(
        sessions.map((session, index) =>
          preferenceService.get(
            `sqlite-dummy-user-${index}`,
            session.deviceId,
          ),
        ),
      );
      expect(readPreferences).toEqual(writtenPreferences);

      const counts = database
        .prepare<
          [],
          {
            challenge_count: number;
            approved_challenge_count: number;
            pairing_hash_count: number;
            session_count: number;
            session_id_count: number;
            device_id_count: number;
            token_hash_count: number;
            preference_count: number;
          }
        >(`
          SELECT
            (SELECT COUNT(*) FROM pairing_challenges) AS challenge_count,
            (
              SELECT COUNT(*)
              FROM pairing_challenges
              WHERE status = 'approved'
            ) AS approved_challenge_count,
            (
              SELECT COUNT(DISTINCT pairing_code_hash)
              FROM pairing_challenges
            ) AS pairing_hash_count,
            (SELECT COUNT(*) FROM device_sessions) AS session_count,
            (
              SELECT COUNT(DISTINCT session_id)
              FROM device_sessions
            ) AS session_id_count,
            (
              SELECT COUNT(DISTINCT device_id)
              FROM device_sessions
            ) AS device_id_count,
            (
              SELECT COUNT(DISTINCT token_hash)
              FROM device_sessions
            ) AS token_hash_count,
            (
              SELECT COUNT(*)
              FROM notification_preferences
            ) AS preference_count
        `)
        .get();
      expect(counts).toEqual({
        challenge_count: DUMMY_USER_COUNT,
        approved_challenge_count: DUMMY_USER_COUNT,
        pairing_hash_count: DUMMY_USER_COUNT,
        session_count: DUMMY_USER_COUNT,
        session_id_count: DUMMY_USER_COUNT,
        device_id_count: DUMMY_USER_COUNT,
        token_hash_count: DUMMY_USER_COUNT,
        preference_count: DUMMY_USER_COUNT,
      });

      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });
});
