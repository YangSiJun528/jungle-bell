import webPush from "web-push";
import { z } from "zod";
import { isAllowedBrowserPushEndpoint } from "../renewal/push-sender";

interface Env {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

interface WebPushTransport {
  sendNotification(
    subscription: webPush.PushSubscription,
    payload: string,
    options: webPush.RequestOptions,
  ): Promise<webPush.SendResult>;
}

const MAX_REQUEST_BYTES = 8 * 1024;
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/u);
const relayRequestSchema = z.object({
  endpoint: z.string().max(2_048).refine(isAllowedBrowserPushEndpoint),
  keys: z.object({
    p256dh: base64UrlSchema.min(40).max(256),
    auth: base64UrlSchema.min(16).max(128),
  }).strict(),
  payload: z.record(z.string(), z.unknown()),
  ttl: z.number().int().min(0).max(15 * 60),
  urgency: z.enum(["very-low", "low", "normal", "high"]),
}).strict();

function textResponse(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

function providerStatus(error: unknown): number {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return 502;
  const value = (error as { statusCode?: unknown }).statusCode;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 400 || value > 599) return 502;
  return value;
}

export async function handleWebPushRelay(
  request: Request,
  env: Env,
  transport: WebPushTransport = webPush,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/send") return textResponse(404, "NOT_FOUND");
  if (request.method !== "POST") return textResponse(405, "METHOD_NOT_ALLOWED");

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return textResponse(413, "PAYLOAD_TOO_LARGE");
  }

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_REQUEST_BYTES) {
    return textResponse(413, "PAYLOAD_TOO_LARGE");
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return textResponse(400, "INVALID_JSON");
  }
  const parsed = relayRequestSchema.safeParse(body);
  if (!parsed.success) return textResponse(400, "INVALID_PUSH_REQUEST");

  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return textResponse(503, "VAPID_NOT_CONFIGURED");

  try {
    await transport.sendNotification(
      { endpoint: parsed.data.endpoint, keys: parsed.data.keys },
      JSON.stringify(parsed.data.payload),
      {
        TTL: parsed.data.ttl,
        urgency: parsed.data.urgency,
        timeout: 10_000,
        vapidDetails: { subject, publicKey, privateKey },
      },
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return textResponse(providerStatus(error), "PUSH_PROVIDER_ERROR");
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleWebPushRelay(request, env);
  },
} satisfies ExportedHandler<Env>;
