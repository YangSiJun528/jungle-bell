import { describe, expect, it } from "vitest";

import {
  DEVICE_SESSION_SCOPES,
  InMemoryPairingStore,
  PairingService,
  decodePairingQrPayload,
} from "./domain/index.js";
import {
  CryptoRandomSource,
  Sha256Hasher,
  SystemClock,
} from "./infra/crypto.js";

describe("dummy target-size load", () => {
  it("pairs and authenticates 200 independent companion devices", async () => {
    const service = new PairingService({
      clock: new SystemClock(),
      random: new CryptoRandomSource(),
      hasher: new Sha256Hasher(),
      store: new InMemoryPairingStore(),
      challengeTtlMs: 60_000,
      deviceSessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    });

    const sessions = await Promise.all(
      Array.from({ length: 200 }, async (_, index) => {
        const challenge = await service.createChallenge({
          userId: `dummy-user-${index}`,
          desktopDeviceId: `dummy-desktop-${index}`,
        });
        const payload = decodePairingQrPayload(challenge.qrPayload);
        await service.claimPairing({
          pairingCode: payload.pairingCode,
          deviceLabel: `Dummy phone ${index}`,
          installationId: `jbmi_${index
            .toString(16)
            .padStart(32, "0")}`,
        });
        return service.approvePairing({
          challengeId: challenge.challengeId,
          desktopDeviceId: `dummy-desktop-${index}`,
          scopes: DEVICE_SESSION_SCOPES,
        });
      }),
    );

    expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(200);
    expect(new Set(sessions.map((session) => session.deviceId)).size).toBe(200);
    expect(new Set(sessions.map((session) => session.sessionToken)).size).toBe(
      200,
    );

    const principals = await Promise.all(
      sessions.map((session) =>
        service.authenticateDeviceSession(
          session.sessionToken,
          "notifications:receive",
        ),
      ),
    );
    expect(principals).toHaveLength(200);
  });
});
