import { z } from "zod";

export const MAX_PUSH_PAYLOAD_BYTES = 2_048;

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;
const TAG_PATTERN = /^[A-Za-z0-9:_-]+$/u;
const EXACT_PUSH_SERVICE_HOSTS = new Set([
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

const internalPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /%5c/iu.test(path) ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      context.addIssue({
        code: "custom",
        message: "path must be an internal same-origin path",
      });
    }
  });

export const pushPayloadSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(240),
    path: internalPathSchema,
    tag: z.string().min(1).max(64).regex(TAG_PATTERN),
  })
  .strict();

export const browserPushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .max(2_048)
      .superRefine((value, context) => {
        try {
          const endpoint = new URL(value);
          if (
            endpoint.protocol !== "https:" ||
            endpoint.username !== "" ||
            endpoint.password !== "" ||
            (endpoint.port !== "" && endpoint.port !== "443") ||
            !isAllowedPushServiceHost(endpoint.hostname)
          ) {
            context.addIssue({
              code: "custom",
              message:
                "push endpoint must use a supported HTTPS push service",
            });
          }
        } catch {
          context.addIssue({
            code: "custom",
            message: "push endpoint must be a valid URL",
          });
        }
      }),
    expirationTime: z.number().int().nonnegative().nullable(),
    keys: z
      .object({
        auth: z.string().min(16).max(256).regex(BASE64_URL_PATTERN),
        p256dh: z.string().min(32).max(512).regex(BASE64_URL_PATTERN),
      })
      .strict(),
  })
  .strict();

export type PushPayload = z.infer<typeof pushPayloadSchema>;
export type BrowserPushSubscription = z.infer<
  typeof browserPushSubscriptionSchema
>;

export type PushPayloadErrorCode =
  | "INVALID_PAYLOAD"
  | "INVALID_SUBSCRIPTION"
  | "PAYLOAD_TOO_LARGE";

export class PushPayloadError extends Error {
  constructor(
    readonly code: PushPayloadErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PushPayloadError";
  }
}

export function serializePushPayload(input: unknown): string {
  const parsed = pushPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new PushPayloadError(
      "INVALID_PAYLOAD",
      "Push payload does not match the versioned contract.",
      { cause: parsed.error },
    );
  }

  const serialized = JSON.stringify(parsed.data);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_PUSH_PAYLOAD_BYTES) {
    throw new PushPayloadError(
      "PAYLOAD_TOO_LARGE",
      `Push payload exceeds ${MAX_PUSH_PAYLOAD_BYTES} UTF-8 bytes.`,
    );
  }
  return serialized;
}

export function parsePushSubscription(
  input: unknown,
): BrowserPushSubscription {
  const parsed = browserPushSubscriptionSchema.safeParse(input);
  if (!parsed.success) {
    throw new PushPayloadError(
      "INVALID_SUBSCRIPTION",
      "Push subscription does not match the browser contract.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function isAllowedPushServiceHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    EXACT_PUSH_SERVICE_HOSTS.has(normalized) ||
    normalized.endsWith(".notify.windows.com")
  );
}
