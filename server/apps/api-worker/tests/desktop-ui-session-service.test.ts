import { describe, expect, it } from "vitest";
import { hashAppSessionToken } from "../../../shared/renewal/crypto";
import { MemoryRenewalStore } from "../../../shared/tests/helpers/memory-renewal-store";
import { RenewalError, type Principal } from "../src/domain/session";
import {
  DESKTOP_UI_SESSION_TTL_MS,
  DesktopUiSessionService,
} from "../src/services/desktop-ui-session-service";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");
const ORIGIN = "tauri://localhost";

async function fixture() {
  const store = new MemoryRenewalStore();
  const accessToken = `jbd_${"a".repeat(64)}`;
  await store.enrollDesktop({
    candidateUserId: "user-1",
    installationId: "desktop-1",
    sessionId: "desktop-session-1",
    tokenSha256: await hashAppSessionToken(accessToken),
    nowEpochMs: NOW,
    expiresAtEpochMs: NOW + 60_000,
  });
  const principal: Principal = {
    sessionId: "desktop-session-1",
    userId: "user-1",
    installationId: "desktop-1",
    kind: "desktop",
  };
  return { store, service: new DesktopUiSessionService(store), principal };
}

describe("DesktopUiSessionService", () => {
  it("issues a 256-bit opaque token with seven-minute absolute expiry and stores only its hash", async () => {
    const { store, service, principal } = await fixture();
    const result = await service.issue(principal, ORIGIN, NOW);

    expect(result).toEqual({
      accessToken: expect.stringMatching(/^jbui_[a-f0-9]{64}$/u),
      expiresAt: new Date(NOW + DESKTOP_UI_SESSION_TTL_MS).toISOString(),
    });
    expect(result.accessToken).toMatch(/^jbui_[a-f0-9]{64}$/u);
    expect(JSON.stringify(store.persistedValues)).not.toContain(result.accessToken);
    await expect(service.authenticate(result.accessToken, ORIGIN, NOW + 1)).resolves.toEqual(principal);
  });

  it("upserts one session per parent and invalidates the previous token immediately", async () => {
    const { service, principal } = await fixture();
    const first = await service.issue(principal, ORIGIN, NOW);
    const second = await service.issue(principal, ORIGIN, NOW + 1);

    await expect(service.authenticate(first.accessToken, ORIGIN, NOW + 2))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", status: 401 });
    await expect(service.authenticate(second.accessToken, ORIGIN, NOW + 2)).resolves.toEqual(principal);
  });

  it("rejects expiry, wrong origin, wrong scope, and an expired or revoked parent", async () => {
    const { store, service, principal } = await fixture();
    const result = await service.issue(principal, ORIGIN, NOW);

    await expect(service.authenticate(result.accessToken, "http://tauri.localhost", NOW + 1))
      .rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED", status: 403 });
    await expect(service.authenticate(result.accessToken, ORIGIN, NOW + DESKTOP_UI_SESSION_TTL_MS))
      .rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });

    const record = [...store.desktopUiSessions.values()][0]!;
    store.desktopUiSessions.set(record.parentSessionId, { ...record, scope: "notification:write" });
    await expect(service.authenticate(result.accessToken, ORIGIN, NOW + 1))
      .rejects.toMatchObject({ code: "SESSION_SCOPE_DENIED", status: 403 });

    store.desktopUiSessions.set(record.parentSessionId, record);
    const parent = store.sessions.get(principal.sessionId)!;
    store.sessions.set(parent.id, { ...parent, expiresAtEpochMs: NOW + 1 });
    await expect(service.authenticate(result.accessToken, ORIGIN, NOW + 1))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", status: 401 });
    store.sessions.set(parent.id, { ...parent, revokedAtEpochMs: NOW + 1 });
    await expect(service.authenticate(result.accessToken, ORIGIN, NOW + 1))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", status: 401 });
  });

  it("supports idempotent best-effort revocation by the current parent", async () => {
    const { service, principal } = await fixture();
    const result = await service.issue(principal, ORIGIN, NOW);

    await expect(service.revoke(principal, ORIGIN)).resolves.toBe(true);
    await expect(service.revoke(principal, ORIGIN)).resolves.toBe(false);
    await expect(service.authenticate(result.accessToken, ORIGIN, NOW + 1))
      .rejects.toBeInstanceOf(RenewalError);
  });
});
