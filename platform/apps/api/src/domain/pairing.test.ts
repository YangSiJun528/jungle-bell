import { describe, expect, it } from "vitest";
import type { Clock, Hasher, RandomSource } from "./ports";
import {
  DEFAULT_DEVICE_SESSION_TTL_MS,
  DEVICE_SESSION_LAST_SEEN_WRITE_INTERVAL_MS,
  InMemoryPairingStore,
  PairingService,
  decodePairingQrPayload,
} from "./pairing";

class TestClock implements Clock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

class SequenceRandom implements RandomSource {
  private next = 1;

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.next;
      this.next = (this.next + 1) % 256;
      return value;
    });
  }
}

class TestHasher implements Hasher {
  async hash(value: string): Promise<string> {
    let result = 2_166_136_261;
    for (const character of value) {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16_777_619);
    }
    return `test-hash-${(result >>> 0).toString(16).padStart(8, "0")}`;
  }
}

function createSubject(
  deviceSessionTtlMs = DEFAULT_DEVICE_SESSION_TTL_MS,
) {
  const clock = new TestClock(Date.parse("2026-07-30T00:00:00.000Z"));
  const random = new SequenceRandom();
  const hasher = new TestHasher();
  const store = new InMemoryPairingStore();
  const service = new PairingService({
    clock,
    random,
    hasher,
    store,
    challengeTtlMs: 60_000,
    deviceSessionTtlMs,
  });
  return { clock, hasher, random, service, store };
}

async function claimAndApprove(
  service: PairingService,
  label: string,
  desktopDeviceId = "desktop-1",
) {
  const challenge = await service.createChallenge({
    userId: "user-1",
    desktopDeviceId,
  });
  const qr = decodePairingQrPayload(challenge.qrPayload);
  await service.claimPairing({
    pairingCode: qr.pairingCode,
    deviceLabel: label,
    installationId: installationId(label),
  });
  return service.approvePairing({
    challengeId: challenge.challengeId,
    desktopDeviceId,
    scopes: ["notifications:receive", "preferences:write"],
  });
}

describe("PairingService", () => {
  it("creates a short-lived QR challenge containing only an ephemeral pairing proof", async () => {
    const { hasher, service, store } = createSubject();

    const challenge = await service.createChallenge({
      userId: "user-secret",
      desktopDeviceId: "desktop-secret",
    });
    const qr = decodePairingQrPayload(challenge.qrPayload);

    expect(Object.keys(qr).sort()).toEqual([
      "expiresAtEpochMs",
      "kind",
      "pairingCode",
      "version",
    ]);
    expect(qr.pairingCode).toMatch(/^jbp_[0-9a-f]{64}$/);
    expect(challenge.manualCode).toMatch(
      /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/u,
    );
    expect(qr.expiresAtEpochMs).toBe(challenge.expiresAtEpochMs);
    expect(challenge.qrPayload).not.toContain("user-secret");
    expect(challenge.qrPayload).not.toContain("desktop-secret");
    expect(challenge.qrPayload).not.toMatch(/session|credential|cookie|jwt/i);

    const stored = await store.getChallenge(challenge.challengeId);
    expect(stored?.pairingCodeHash).toBe(await hasher.hash(qr.pairingCode));
    expect(JSON.stringify(stored)).not.toContain(qr.pairingCode);
  });

  it("expires the proof and consumes it on the first phone claim", async () => {
    const { clock, service } = createSubject();
    const expired = await service.createChallenge({
      userId: "user-1",
      desktopDeviceId: "desktop-1",
    });
    clock.advance(60_001);

    await expect(
      service.claimPairing({
        pairingCode: decodePairingQrPayload(expired.qrPayload).pairingCode,
        deviceLabel: "My phone",
        installationId: installationId("expired"),
      }),
    ).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });

    const fresh = await service.createChallenge({
      userId: "user-1",
      desktopDeviceId: "desktop-1",
    });
    const pairingCode = decodePairingQrPayload(fresh.qrPayload).pairingCode;
    await service.claimPairing({
      pairingCode,
      deviceLabel: "My phone",
      installationId: installationId("fresh"),
    });

    await expect(
      service.claimPairing({
        pairingCode,
        deviceLabel: "Another phone",
        installationId: installationId("attacker"),
      }),
    ).rejects.toMatchObject({ code: "PAIRING_ALREADY_USED" });
  });

  it("requires the originating desktop to approve the claimed device label", async () => {
    const { hasher, service, store } = createSubject();
    const challenge = await service.createChallenge({
      userId: "user-1",
      desktopDeviceId: "desktop-1",
    });
    const qr = decodePairingQrPayload(challenge.qrPayload);

    await service.claimPairing({
      pairingCode: qr.pairingCode,
      deviceLabel: "Sijun's phone",
      installationId: installationId("sijun"),
    });

    expect(await store.listDeviceSessions("user-1")).toEqual([]);
    expect(
      await service.getPendingClaim({
        challengeId: challenge.challengeId,
        desktopDeviceId: "desktop-1",
      }),
    ).toEqual({
      deviceLabel: "Sijun's phone",
      installationId: installationId("sijun"),
    });
    await expect(
      service.approvePairing({
        challengeId: challenge.challengeId,
        desktopDeviceId: "desktop-2",
        scopes: ["notifications:receive"],
      }),
    ).rejects.toMatchObject({ code: "PAIRING_DESKTOP_MISMATCH" });

    const approved = await service.approvePairing({
      challengeId: challenge.challengeId,
      desktopDeviceId: "desktop-1",
      scopes: [
        "preferences:write",
        "notifications:receive",
        "notifications:receive",
      ],
    });

    expect(approved.sessionToken).toMatch(/^jbs_[0-9a-f]{64}$/);
    expect(approved.sessionToken.split(".")).toHaveLength(1);
    expect(approved.scopes).toEqual([
      "notifications:receive",
      "preferences:write",
    ]);

    const stored = await store.getDeviceSession(approved.sessionId);
    expect(stored?.tokenHash).toBe(await hasher.hash(approved.sessionToken));
    expect(JSON.stringify(stored)).not.toContain(approved.sessionToken);
    expect(stored).toMatchObject({
      userId: "user-1",
      deviceId: approved.deviceId,
      deviceLabel: "Sijun's phone",
      expiresAtEpochMs:
        Date.parse("2026-07-30T00:00:00.000Z") +
        DEFAULT_DEVICE_SESSION_TTL_MS,
      lastSeenAtEpochMs: Date.parse("2026-07-30T00:00:00.000Z"),
      revokedAtEpochMs: null,
    });

    await expect(
      service.approvePairing({
        challengeId: challenge.challengeId,
        desktopDeviceId: "desktop-1",
        scopes: ["notifications:receive"],
      }),
    ).rejects.toMatchObject({ code: "PAIRING_ALREADY_USED" });
  });

  it("claims the same one-time challenge by its normalized manual code", async () => {
    const { service } = createSubject();
    const challenge = await service.createChallenge({
      userId: "user-1",
      desktopDeviceId: "desktop-1",
    });
    const formatted =
      `${challenge.manualCode.slice(0, 5)}-` +
      challenge.manualCode.slice(5).toLowerCase();

    await service.claimPairing({
      manualCode: formatted,
      deviceLabel: "Installed PWA",
      installationId: installationId("manual"),
    });

    await expect(
      service.getPendingClaim({
        challengeId: challenge.challengeId,
        desktopDeviceId: "desktop-1",
      }),
    ).resolves.toEqual({
      deviceLabel: "Installed PWA",
      installationId: installationId("manual"),
    });
    await expect(
      service.claimPairing({
        manualCode: challenge.manualCode,
        deviceLabel: "Replay",
        installationId: installationId("replay"),
      }),
    ).rejects.toMatchObject({ code: "PAIRING_ALREADY_USED" });
  });

  it("revokes one opaque device session without affecting another", async () => {
    const { service } = createSubject();
    const first = await claimAndApprove(service, "Phone A");
    const second = await claimAndApprove(service, "Phone B");

    await expect(
      service.authenticateDeviceSession(first.sessionToken, "preferences:write"),
    ).resolves.toMatchObject({ deviceId: first.deviceId });
    await expect(
      service.authenticateDeviceSession(
        second.sessionToken,
        "notifications:receive",
      ),
    ).resolves.toMatchObject({ deviceId: second.deviceId });

    await service.revokeDeviceSession({
      userId: "user-1",
      sessionId: first.sessionId,
    });

    await expect(
      service.authenticateDeviceSession(first.sessionToken),
    ).rejects.toMatchObject({ code: "DEVICE_SESSION_REVOKED" });
    await expect(
      service.authenticateDeviceSession(
        second.sessionToken,
        "notifications:receive",
      ),
    ).resolves.toMatchObject({ deviceId: second.deviceId });
    await expect(
      service.authenticateDeviceSession(
        second.sessionToken,
        "preferences:read",
      ),
    ).rejects.toMatchObject({ code: "DEVICE_SESSION_SCOPE_DENIED" });
  });

  it("persists the issued expiry instead of recalculating it from later configuration", async () => {
    const { clock, hasher, random, service, store } = createSubject(1_000);
    const session = await claimAndApprove(service, "Expiring phone");
    clock.advance(1_000);

    const reconfigured = new PairingService({
      clock,
      random,
      hasher,
      store,
      challengeTtlMs: 60_000,
      deviceSessionTtlMs: DEFAULT_DEVICE_SESSION_TTL_MS,
    });

    await expect(
      reconfigured.authenticateDeviceSession(session.sessionToken),
    ).rejects.toMatchObject({ code: "DEVICE_SESSION_EXPIRED" });
  });

  it("writes mobile activity at most once per tracking interval", async () => {
    const { clock, service, store } = createSubject();
    const session = await claimAndApprove(service, "Tracked phone");
    const initial = await store.getDeviceSession(session.sessionId);

    clock.advance(DEVICE_SESSION_LAST_SEEN_WRITE_INTERVAL_MS - 1);
    await service.authenticateDeviceSession(session.sessionToken);
    expect(await store.getDeviceSession(session.sessionId)).toMatchObject({
      lastSeenAtEpochMs: initial?.lastSeenAtEpochMs,
    });

    clock.advance(1);
    await service.authenticateDeviceSession(session.sessionToken);
    expect(await store.getDeviceSession(session.sessionId)).toMatchObject({
      lastSeenAtEpochMs: clock.now(),
    });
  });

  it("uses a one-year default device lifetime", async () => {
    const { clock, service } = createSubject();
    const session = await claimAndApprove(service, "Expiring phone");

    clock.advance(DEFAULT_DEVICE_SESSION_TTL_MS);

    await expect(
      service.authenticateDeviceSession(session.sessionToken),
    ).rejects.toMatchObject({ code: "DEVICE_SESSION_EXPIRED" });
  });
});

function installationId(seed: string): string {
  const value = [...seed].reduce(
    (total, character) =>
      (Math.imul(total, 31) + character.charCodeAt(0)) >>> 0,
    0,
  );
  return `jbmi_${value.toString(16).padStart(32, "0")}`;
}
