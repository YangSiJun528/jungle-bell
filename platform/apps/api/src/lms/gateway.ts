import { CookieJar } from "tough-cookie";

import {
  normalizeLmsCookies,
  type LmsCookie,
} from "./session-vault.js";

export const DEFAULT_LMS_ORIGIN = "https://jungle-lms.krafton.com";

const ME_PATH = "/api/v2/me";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_RESPONSE_BYTES = 512 * 1024;

export interface LmsVerificationResult {
  readonly authenticated: boolean;
  readonly subject: string | null;
}

export type LmsGatewayFailureKind =
  | "auth-invalid"
  | "transient"
  | "invalid-input"
  | "invalid-response";

export interface LmsHttpGatewayOptions {
  readonly fetcher?: typeof fetch;
  /**
   * Transport origin override. It accepts only the canonical LMS origin, or
   * plain-HTTP loopback when allowTestLoopbackHttp is explicitly enabled.
   * Cookie matching always uses DEFAULT_LMS_ORIGIN.
   */
  readonly origin?: string;
  readonly timeoutMs?: number;
  /**
   * Enables plain HTTP only for an explicitly injected loopback fake LMS.
   * Production callers must leave this false.
   */
  readonly allowTestLoopbackHttp?: boolean;
}

interface LmsGatewayErrorOptions {
  readonly failureKind?: LmsGatewayFailureKind;
  readonly status?: number | null;
}

export class LmsGatewayError extends Error {
  readonly failureKind: LmsGatewayFailureKind;
  readonly status: number | null;

  constructor(
    readonly code: string,
    options: LmsGatewayErrorOptions = {},
  ) {
    super(code);
    this.name = "LmsGatewayError";
    this.failureKind = options.failureKind ?? "invalid-input";
    this.status = options.status ?? null;
  }
}

interface AuthenticatedTransportResult {
  readonly response: Response;
}

function readSingleAccessCookie(
  input: readonly LmsCookie[],
): LmsCookie {
  if (input.length !== 1) {
    throw new LmsGatewayError("LMS_ACCESS_COOKIE_REQUIRED");
  }
  const normalized = normalizeLmsCookies(input);
  const accessCookie = normalized[0];
  if (
    normalized.length !== 1 ||
    accessCookie === undefined ||
    accessCookie.name !== "access_token" ||
    (accessCookie.expires >= 0 &&
      accessCookie.expires <= Math.floor(Date.now() / 1_000))
  ) {
    throw new LmsGatewayError("LMS_ACCESS_COOKIE_REQUIRED");
  }
  return accessCookie;
}

export class LmsHttpGateway {
  private readonly fetcher: typeof fetch;
  private readonly transportOrigin: string;
  private readonly timeoutMs: number;

  constructor(
    input: typeof fetch | LmsHttpGatewayOptions = {},
    legacyTimeoutMs?: number,
  ) {
    const options: LmsHttpGatewayOptions =
      typeof input === "function"
        ? {
            fetcher: input,
            ...(legacyTimeoutMs === undefined
              ? {}
              : { timeoutMs: legacyTimeoutMs }),
          }
        : input;
    this.fetcher = options.fetcher ?? fetch;
    this.transportOrigin = normalizeLmsTransportOrigin(
      options.origin ?? DEFAULT_LMS_ORIGIN,
      options.allowTestLoopbackHttp === true,
    );
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
  }

  async verifyIdentity(
    input: readonly LmsCookie[],
  ): Promise<LmsVerificationResult> {
    const accessCookie = readSingleAccessCookie(input);
    const result = await this.authenticatedGet(ME_PATH, [accessCookie]);
    if (result.response.status === 200) {
      const body = await readJsonResponse(
        result.response,
        "LMS_ME_RESPONSE_INVALID",
        result,
        false,
      );
      return {
        authenticated: true,
        subject: readLmsSubject(body),
      };
    }
    await discardResponseBody(result.response);
    if (
      result.response.status === 401 ||
      result.response.status === 403
    ) {
      return {
        authenticated: false,
        subject: null,
      };
    }
    if (
      result.response.status === 408 ||
      result.response.status === 429 ||
      result.response.status >= 500
    ) {
      throw contextualError(
        "LMS_UPSTREAM_STATUS",
        "transient",
        result,
      );
    }
    throw contextualError(
      "LMS_ME_RESPONSE_INVALID",
      "invalid-response",
      result,
    );
  }

  private async authenticatedGet(
    path: string,
    input: readonly LmsCookie[],
  ): Promise<AuthenticatedTransportResult> {
    const cookies = await LmsRequestCookieJar.create(input);
    const response = await this.request(path, cookies);
    return { response };
  }

  private async request(
    path: string,
    cookies: LmsRequestCookieJar,
  ): Promise<Response> {
    const cookieHeader = await cookies.headerFor(path);
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.fetcher(`${this.transportOrigin}${path}`, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          ...(cookieHeader === "" ? {} : { cookie: cookieHeader }),
        },
      });
    } catch {
      throw new LmsGatewayError(
        signal.aborted
          ? "LMS_UPSTREAM_TIMEOUT"
          : "LMS_UPSTREAM_REQUEST_FAILED",
        {
          failureKind: "transient",
          status: null,
        },
      );
    }
  }
}

async function readJsonResponse(
  response: Response,
  code: string,
  context: AuthenticatedTransportResult,
  allowEmpty: boolean,
): Promise<unknown> {
  if (!isJsonContentType(response.headers.get("content-type"))) {
    await discardResponseBody(response);
    throw contextualError(code, "invalid-response", context);
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_JSON_RESPONSE_BYTES
  ) {
    await discardResponseBody(response);
    throw contextualError(code, "invalid-response", context);
  }

  const text = await readResponseTextWithinLimit(response, code, context);
  if (text.trim() === "") {
    if (allowEmpty) {
      return null;
    }
    throw contextualError(code, "invalid-response", context);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw contextualError(code, "invalid-response", context);
  }
}

async function readResponseTextWithinLimit(
  response: Response,
  code: string,
  context: AuthenticatedTransportResult,
): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_JSON_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the invalid-response classification if cancellation fails.
        }
        throw contextualError(code, "invalid-response", context);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof LmsGatewayError) {
      throw error;
    }
    try {
      await reader.cancel();
    } catch {
      // The upstream stream may already be errored or closed.
    }
    throw contextualError("LMS_UPSTREAM_BODY_READ_FAILED", "transient", context);
  } finally {
    reader.releaseLock();
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.bodyUsed) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // A failed or already-closed upstream body needs no further handling.
  }
}

function contextualError(
  code: string,
  failureKind: LmsGatewayFailureKind,
  context: AuthenticatedTransportResult,
): LmsGatewayError {
  return new LmsGatewayError(code, {
    failureKind,
    status: context.response.status,
  });
}

function isJsonContentType(value: string | null): boolean {
  return (
    value !== null &&
    /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/iu.test(value)
  );
}

function readLmsSubject(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const value = record.id;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
  }
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  return null;
}

class LmsRequestCookieJar {
  private constructor(private readonly jar: CookieJar) {}

  static async create(
    input: readonly LmsCookie[],
  ): Promise<LmsRequestCookieJar> {
    const jar = new CookieJar(undefined, {
      allowSecureOnLocal: false,
      allowSpecialUseDomain: false,
      looseMode: false,
      prefixSecurity: "strict",
      rejectPublicSuffixes: true,
    });
    const adapter = new LmsRequestCookieJar(jar);
    const now = new Date();
    const nowEpochSeconds = Math.floor(now.getTime() / 1000);

    for (const cookie of normalizeLmsCookies(input)) {
      if (cookie.expires >= 0 && cookie.expires <= nowEpochSeconds) {
        continue;
      }
      const attributes = [
        `${cookie.name}=${cookie.value}`,
        `Path=${cookie.path}`,
        cookie.secure ? "Secure" : "",
        cookie.httpOnly ? "HttpOnly" : "",
        `SameSite=${cookie.sameSite}`,
      ];
      if (cookie.expires >= 0) {
        const expires = new Date(cookie.expires * 1_000);
        if (Number.isNaN(expires.getTime())) {
          throw new LmsGatewayError("LMS_COOKIE_INVALID");
        }
        attributes.push(`Expires=${expires.toUTCString()}`);
      }
      try {
        await jar.setCookie(
          attributes.filter((attribute) => attribute !== "").join("; "),
          logicalLmsUrl("/"),
          {
            http: true,
            ignoreError: false,
            loose: false,
            now,
            sameSiteContext: "strict",
          },
        );
      } catch {
        throw new LmsGatewayError("LMS_COOKIE_INVALID");
      }
    }
    return adapter;
  }

  async headerFor(path: string): Promise<string> {
    return this.jar.getCookieString(logicalLmsUrl(path).href, {
      http: true,
      sameSiteContext: "strict",
    });
  }

}

function logicalLmsUrl(path: string): URL {
  return new URL(path, DEFAULT_LMS_ORIGIN);
}

function normalizeLmsTransportOrigin(
  value: string,
  allowTestLoopbackHttp: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new LmsGatewayError("LMS_ORIGIN_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LmsGatewayError("LMS_ORIGIN_INVALID");
  }
  const withoutTrailingSlash = value.endsWith("/")
    ? value.slice(0, -1)
    : value;
  const exactOrigin =
    parsed.origin === withoutTrailingSlash &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "";
  const canonicalProductionOrigin =
    parsed.protocol === "https:" &&
    parsed.origin === DEFAULT_LMS_ORIGIN;
  const optedInLoopback =
    allowTestLoopbackHttp &&
    parsed.protocol === "http:" &&
    isLoopbackHost(parsed.hostname);
  if (!exactOrigin || (!canonicalProductionOrigin && !optedInLoopback)) {
    throw new LmsGatewayError("LMS_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function isLoopbackHost(hostname: string): boolean {
  const canonical = hostname
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase("en-US");
  if (canonical === "localhost" || canonical === "::1") {
    return true;
  }
  const octets = canonical.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/u.test(octet)) {
        return false;
      }
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60_000
  ) {
    throw new LmsGatewayError("LMS_TIMEOUT_INVALID");
  }
  return timeout;
}
