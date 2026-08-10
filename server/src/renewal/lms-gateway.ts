import { z } from "zod";

export const LMS_ORIGIN = "https://jungle-lms.krafton.com";
const LMS_ME_URL = `${LMS_ORIGIN}/api/v2/me`;
const MAX_RESPONSE_BYTES = 512 * 1024;

export const lmsCookieSchema = z.object({
  name: z.literal("access_token"),
  value: z.string().min(1).max(8_192).regex(/^[\x21-\x3A\x3C-\x5B\x5D-\x7E]+$/u),
  domain: z.string().transform((value, context) => {
    const normalized = value.replace(/^\./u, "").toLowerCase();
    if (normalized !== "jungle-lms.krafton.com") context.addIssue({ code: "custom", message: "Invalid LMS cookie domain" });
    return normalized;
  }),
  path: z.literal("/"),
  expires: z.number().finite(),
  httpOnly: z.literal(true),
  secure: z.literal(true),
  sameSite: z.enum(["Strict", "Lax", "None"]),
}).strict().superRefine((cookie, context) => {
  if (cookie.expires !== -1 && cookie.expires <= Math.floor(Date.now() / 1_000)) {
    context.addIssue({ code: "custom", message: "Expired LMS cookie" });
  }
});

export type LmsAccessCookie = z.infer<typeof lmsCookieSchema>;

export interface LmsIdentityGateway {
  verifyIdentity(cookies: readonly LmsAccessCookie[]): Promise<{
    authenticated: boolean;
    subject: string | null;
  }>;
}

export class LmsGatewayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LmsGatewayError";
  }
}

export class HttpLmsIdentityGateway implements LmsIdentityGateway {
  private readonly fetcher: typeof fetch;

  constructor(fetcher?: typeof fetch) {
    const request = fetcher ?? globalThis.fetch.bind(globalThis);
    this.fetcher = (input, init) => request(input, init);
  }

  async verifyIdentity(cookies: readonly LmsAccessCookie[]): Promise<{
    authenticated: boolean;
    subject: string | null;
  }> {
    if (cookies.length !== 1 || cookies[0]?.name !== "access_token") {
      throw new LmsGatewayError("LMS_ACCESS_COOKIE_REQUIRED");
    }
    let response: Response;
    try {
      response = await this.fetcher(LMS_ME_URL, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          cookie: `access_token=${cookies[0].value}`,
        },
      });
    } catch (error) {
      console.warn("[lms-gateway] upstream request failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : "non-error thrown",
      });
      throw new LmsGatewayError("LMS_UPSTREAM_UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403) {
      await discardBody(response);
      return { authenticated: false, subject: null };
    }
    if (response.status !== 200) {
      console.warn("[lms-gateway] upstream returned an unexpected status", {
        status: response.status,
      });
      await discardBody(response);
      throw new LmsGatewayError("LMS_UPSTREAM_UNAVAILABLE");
    }
    if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      await discardBody(response);
      throw new LmsGatewayError("LMS_IDENTITY_RESPONSE_INVALID");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await discardBody(response);
      throw new LmsGatewayError("LMS_IDENTITY_RESPONSE_INVALID");
    }
    const text = await readTextWithinLimit(response);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new LmsGatewayError("LMS_IDENTITY_RESPONSE_INVALID");
    }
    return { authenticated: true, subject: readSubject(body) };
  }
}

function readSubject(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).id;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (
    typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && new TextEncoder().encode(value).byteLength <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value)
  ) return value;
  return null;
}

async function discardBody(response: Response): Promise<void> {
  if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
}

async function readTextWithinLimit(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LmsGatewayError("LMS_IDENTITY_RESPONSE_INVALID");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof LmsGatewayError) throw error;
    throw new LmsGatewayError("LMS_UPSTREAM_UNAVAILABLE");
  } finally {
    reader.releaseLock();
  }
}
