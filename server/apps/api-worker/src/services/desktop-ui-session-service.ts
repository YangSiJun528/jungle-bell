import type { DesktopUiSessionRecord, RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import { hashAppSessionToken, randomOpaqueToken } from "@jungle-bell/backend-common/renewal/crypto";
import { RenewalError, type Principal } from "../domain/session";

export const DESKTOP_UI_SESSION_TTL_MS = 7 * 60_000;
export const DESKTOP_UI_SESSION_SCOPE = "desktop-ui-v1";
export const DESKTOP_UI_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "http://127.0.0.1:5173",
] as const;

export type DesktopUiOrigin = typeof DESKTOP_UI_ORIGINS[number];

export function isDesktopUiOrigin(value: string | undefined): value is DesktopUiOrigin {
  return value !== undefined && (DESKTOP_UI_ORIGINS as readonly string[]).includes(value);
}

export type DesktopUiSessionStore = Pick<RenewalStore,
  | "deleteDesktopUiSession"
  | "findDesktopUiSessionByTokenHash"
  | "hasCurrentDesktopOwnership"
  | "replaceDesktopUiSession"
>;

export class DesktopUiSessionService {
  constructor(private readonly store: DesktopUiSessionStore) {}

  async issue(principal: Principal, origin: DesktopUiOrigin, nowEpochMs: number): Promise<{
    accessToken: string;
    expiresAt: string;
  }> {
    if (principal.kind !== "desktop") throw new RenewalError("DESKTOP_SESSION_REQUIRED", 403);
    const accessToken = randomOpaqueToken("jbui_");
    const expiresAtEpochMs = nowEpochMs + DESKTOP_UI_SESSION_TTL_MS;
    const record: DesktopUiSessionRecord = {
      id: `jbuis_${crypto.randomUUID()}`,
      parentSessionId: principal.sessionId,
      userId: principal.userId,
      installationId: principal.installationId,
      tokenSha256: await hashAppSessionToken(accessToken),
      origin,
      scope: DESKTOP_UI_SESSION_SCOPE,
      createdAtEpochMs: nowEpochMs,
      expiresAtEpochMs,
    };
    if (!(await this.store.replaceDesktopUiSession(record))) {
      throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
    }
    return { accessToken, expiresAt: new Date(expiresAtEpochMs).toISOString() };
  }

  async authenticate(token: string, origin: string | undefined, nowEpochMs: number): Promise<Principal> {
    if (!isDesktopUiOrigin(origin)) throw new RenewalError("ORIGIN_NOT_ALLOWED", 403);
    if (!/^jbui_[0-9a-f]{64}$/u.test(token)) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
    const record = await this.store.findDesktopUiSessionByTokenHash(await hashAppSessionToken(token));
    if (!record) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
    if (record.expiresAtEpochMs <= nowEpochMs) throw new RenewalError("SESSION_EXPIRED", 401);
    if (record.origin !== origin) throw new RenewalError("ORIGIN_NOT_ALLOWED", 403);
    if (record.scope !== DESKTOP_UI_SESSION_SCOPE) throw new RenewalError("SESSION_SCOPE_DENIED", 403);
    if (!(await this.store.hasCurrentDesktopOwnership({
      sessionId: record.parentSessionId,
      userId: record.userId,
      installationId: record.installationId,
      nowEpochMs,
    }))) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
    return {
      sessionId: record.parentSessionId,
      userId: record.userId,
      installationId: record.installationId,
      kind: "desktop",
    };
  }

  revoke(principal: Principal, origin: DesktopUiOrigin): Promise<boolean> {
    if (principal.kind !== "desktop") throw new RenewalError("DESKTOP_SESSION_REQUIRED", 403);
    return this.store.deleteDesktopUiSession({
      parentSessionId: principal.sessionId,
      userId: principal.userId,
      installationId: principal.installationId,
      origin,
    });
  }
}
