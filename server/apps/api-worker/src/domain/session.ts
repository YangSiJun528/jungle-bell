export const DESKTOP_SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
export const MOBILE_SESSION_TTL_MS = 365 * 24 * 60 * 60_000;

export class RenewalError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 502 | 503 = 400) {
    super(code);
    this.name = "RenewalError";
  }
}

export interface Principal {
  sessionId: string;
  userId: string;
  installationId: string;
  kind: "desktop" | "mobile";
}
