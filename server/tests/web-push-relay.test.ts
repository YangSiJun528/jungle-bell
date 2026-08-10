import { describe, expect, it, vi } from "vitest";
import type webPush from "web-push";
import { handleWebPushRelay } from "../src/workers/web-push-relay";

const env = {
  VAPID_PUBLIC_KEY: "public-key",
  VAPID_PRIVATE_KEY: "private-key",
  VAPID_SUBJECT: "https://github.com/YangSiJun528/jungle-bell",
};

const validBody = {
  endpoint: "https://fcm.googleapis.com/fcm/send/example",
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  payload: { title: "출석 확인", path: "/dashboard.html#attendance" },
  ttl: 600,
  urgency: "high",
};

function request(body: unknown = validBody): Request {
  return new Request("https://web-push-relay.internal/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Web Push relay Worker", () => {
  it("encrypts and signs an accepted browser subscription", async () => {
    const sendNotification = vi.fn(async () => ({ statusCode: 201, headers: {}, body: "" }));

    const response = await handleWebPushRelay(request(), env, { sendNotification });

    expect(response.status).toBe(204);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: validBody.endpoint, keys: validBody.keys },
      JSON.stringify(validBody.payload),
      expect.objectContaining({
        TTL: 600,
        urgency: "high",
        timeout: 10_000,
        vapidDetails: expect.objectContaining({ subject: env.VAPID_SUBJECT }),
      }),
    );
  });

  it("rejects requests that could target an arbitrary host", async () => {
    const sendNotification = vi.fn();
    const response = await handleWebPushRelay(request({
      ...validBody,
      endpoint: "https://169.254.169.254/latest/meta-data",
    }), env, { sendNotification: sendNotification as typeof webPush.sendNotification });

    expect(response.status).toBe(400);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each([404, 410, 429, 503])("preserves provider status %s for delivery policy", async (statusCode) => {
    const transport = {
      sendNotification: vi.fn(async () => {
        throw Object.assign(new Error("provider rejected push"), { statusCode });
      }),
    };

    const response = await handleWebPushRelay(request(), env, transport);

    expect(response.status).toBe(statusCode);
    await expect(response.json()).resolves.toEqual({ error: "PUSH_PROVIDER_ERROR" });
  });

  it("does not run without all VAPID settings", async () => {
    const sendNotification = vi.fn();
    const incompleteEnv = {
      VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
      VAPID_SUBJECT: env.VAPID_SUBJECT,
    };
    const response = await handleWebPushRelay(
      request(),
      incompleteEnv,
      { sendNotification: sendNotification as typeof webPush.sendNotification },
    );

    expect(response.status).toBe(503);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
