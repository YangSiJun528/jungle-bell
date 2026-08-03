import { describe, expect, it, vi } from "vitest";

import serviceWorkerSource from "../../public/sw.js?raw";

type EventHandler = (event: unknown) => void;

interface HarnessOptions {
  cacheKeys?: string[];
  clients?: Array<{
    focus: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    postMessage?: ReturnType<typeof vi.fn>;
    url: string;
  }>;
  fetchResponse?: Response;
  fetchResponses?: Response[];
  pushSubscription?: TestPushSubscription | null;
  subscribeResult?: TestPushSubscription;
}

interface TestPushSubscription {
  options?: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => {
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
  };
}

const retryCacheName = "jungle-bell-push-reconcile-v1";
const retryMarkerUrl =
  "https://app.example.test/.jungle-bell/push-reconcile-pending";

function pushSubscription(
  endpoint = "https://push.example.test/rotated",
): TestPushSubscription {
  return {
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: {
        auth: "a".repeat(24),
        p256dh: "b".repeat(88),
      },
    }),
  };
}

function createHarness(options: HarnessOptions = {}) {
  const origin = "https://app.example.test";
  const handlers = new Map<string, EventHandler>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const claimClients = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  const clients = options.clients ?? [];
  const queuedFetchResponses = [...(options.fetchResponses ?? [])];
  const fetchMock = vi.fn(async () =>
    queuedFetchResponses.shift() ??
    options.fetchResponse ??
    new Response(null, { status: 503 }),
  );
  let currentPushSubscription = options.pushSubscription ?? null;
  const subscribe = vi.fn(async () => {
    const subscription =
      options.subscribeResult ?? pushSubscription();
    currentPushSubscription = subscription;
    return subscription;
  });
  const pushManager = {
    getSubscription: vi.fn(async () => currentPushSubscription),
    subscribe,
  };
  const registerSync = vi.fn(async () => undefined);
  const serviceWorkerGlobal = {
    addEventListener(type: string, handler: EventHandler) {
      handlers.set(type, handler);
    },
    clients: {
      claim: claimClients,
      matchAll: vi.fn(async () => clients),
      openWindow,
    },
    location: { origin },
    registration: {
      pushManager,
      showNotification,
      sync: { register: registerSync },
    },
    skipWaiting,
  };
  const cachedResponses = new Map<string, Response>();
  const cache = {
    addAll: vi.fn(async () => undefined),
    delete: vi.fn(async (key: string) => cachedResponses.delete(key)),
    match: vi.fn(async (key: string) => cachedResponses.get(key)),
    put: vi.fn(async (key: string, value: Response) => {
      cachedResponses.set(key, value);
    }),
  };
  const cacheStorage = {
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => options.cacheKeys ?? []),
    match: vi.fn(async () => undefined),
    open: vi.fn(async () => cache),
  };

  new Function("self", "caches", "fetch", serviceWorkerSource)(
    serviceWorkerGlobal,
    cacheStorage,
    fetchMock,
  );

  async function dispatch(type: string, event: Record<string, unknown>) {
    const handler = handlers.get(type);
    if (!handler) {
      throw new Error(`Missing ${type} handler`);
    }

    let completion = Promise.resolve<unknown>(undefined);
    handler({
      ...event,
      waitUntil(value: PromiseLike<unknown> | unknown) {
        completion = Promise.resolve(value);
      },
    });
    await completion;
  }

  async function push(payload: unknown) {
    const text = JSON.stringify(payload);
    await dispatch("push", {
      data: {
        json: () => JSON.parse(text) as unknown,
        text: () => text,
      },
    });
  }

  return {
    cacheStorage,
    claimClients,
    dispatch,
    handlers,
    fetchMock,
    openWindow,
    origin,
    pushManager,
    push,
    registerSync,
    retryCache: cache,
    showNotification,
    skipWaiting,
  };
}

describe("push service worker", () => {
  it("keeps lifecycle cleanup without installing an offline fetch handler", async () => {
    const harness = createHarness({
      cacheKeys: ["jungle-bell-shell-v1", "another-app-cache"],
    });

    await harness.dispatch("install", {});
    await harness.dispatch("activate", {});

    expect(harness.skipWaiting).toHaveBeenCalledOnce();
    expect(harness.claimClients).toHaveBeenCalledOnce();
    expect(harness.cacheStorage.delete).toHaveBeenCalledExactlyOnceWith(
      "jungle-bell-shell-v1",
    );
    expect(harness.cacheStorage.open).toHaveBeenCalledExactlyOnceWith(
      retryCacheName,
    );
    expect(harness.retryCache.put).not.toHaveBeenCalled();
    expect(harness.handlers.has("fetch")).toBe(false);
  });

  it("shows a strictly valid versioned payload", async () => {
    const harness = createHarness();

    await harness.push({
      version: 1,
      title: "세탁 완료",
      body: "3번 세탁기의 종료 시간이 지났습니다.",
      path: "/app/laundry?machine=3",
      tag: "laundry:3:finished",
    });

    expect(harness.showNotification).toHaveBeenCalledWith("세탁 완료", {
      badge: "/badge.svg",
      body: "3번 세탁기의 종료 시간이 지났습니다.",
      data: {
        url: "https://app.example.test/app/laundry?machine=3",
      },
      icon: "/icon-192.png",
      tag: "laundry:3:finished",
    });
  });

  it.each([
    {
      version: 1,
      title: "외부 링크",
      body: "누르면 안 됩니다.",
      path: "https://evil.example/phish",
      tag: "unsafe",
    },
    {
      version: 1,
      title: "추적 이미지",
      body: "추가 필드는 허용하지 않습니다.",
      path: "/app",
      tag: "unsafe",
      image: "https://evil.example/tracker.png",
    },
    {
      version: 2,
      title: "알 수 없는 버전",
      body: "해석하지 않습니다.",
      path: "/app",
      tag: "unsafe",
    },
  ])("falls back for an invalid or non-strict payload", async (payload) => {
    const harness = createHarness();

    await harness.push(payload);

    expect(harness.showNotification).toHaveBeenCalledWith("Jungle Bell", {
      badge: "/badge.svg",
      body: "새로운 알림이 있습니다.",
      data: { url: "https://app.example.test/app" },
      icon: "/icon-192.png",
      tag: "jungle-bell",
    });
  });

  it("falls back before parsing an oversized message", async () => {
    const harness = createHarness();

    await harness.push({
      version: 1,
      title: "큰 메시지",
      body: "가".repeat(2_048),
      path: "/app",
      tag: "oversized",
    });

    expect(harness.showNotification).toHaveBeenCalledWith(
      "Jungle Bell",
      expect.objectContaining({ tag: "jungle-bell" }),
    );
  });

  it("never navigates a window to a cross-origin notification URL", async () => {
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const harness = createHarness({
      clients: [
        {
          focus,
          navigate,
          url: "https://app.example.test/app/meals",
        },
      ],
    });
    const close = vi.fn();

    await harness.dispatch("notificationclick", {
      notification: {
        close,
        data: { url: "https://evil.example/phish" },
      },
    });

    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("https://app.example.test/app");
    expect(focus).toHaveBeenCalledOnce();
    expect(harness.openWindow).not.toHaveBeenCalled();
  });

  it("opens an internal notification URL when no app window exists", async () => {
    const harness = createHarness();

    await harness.dispatch("notificationclick", {
      notification: {
        close: vi.fn(),
        data: {
          url: "https://app.example.test/app/meals?date=2026-07-30",
        },
      },
    });

    expect(harness.openWindow).toHaveBeenCalledWith(
      "https://app.example.test/app/meals?date=2026-07-30",
    );
  });

  it("re-registers a rotated browser Push subscription with the current session", async () => {
    const postMessage = vi.fn();
    const subscriptionId = `jbps_${"a".repeat(64)}`;
    const harness = createHarness({
      clients: [
        {
          focus: vi.fn(),
          navigate: vi.fn(),
          postMessage,
          url: "https://app.example.test/app",
        },
      ],
      fetchResponse: new Response(JSON.stringify({ subscriptionId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: {
        toJSON: () => ({
          endpoint: "https://push.example.test/rotated",
          expirationTime: null,
          keys: {
            auth: "a".repeat(24),
            p256dh: "b".repeat(88),
          },
        }),
      },
    });

    expect(harness.fetchMock).toHaveBeenCalledWith(
      "/api/push/subscriptions",
      expect.objectContaining({
        credentials: "include",
        method: "PUT",
      }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: "push-subscription-reconciled",
      subscriptionId,
    });
  });

  it("keeps a retry pending when a missing subscription cannot be recreated yet", async () => {
    const postMessage = vi.fn();
    const harness = createHarness({
      clients: [
        {
          focus: vi.fn(),
          navigate: vi.fn(),
          postMessage,
          url: "https://app.example.test/app",
        },
      ],
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: null,
    });

    expect(harness.fetchMock).toHaveBeenCalledWith(
      "/api/push/vapid-public-key",
      expect.objectContaining({
        credentials: "include",
        method: "GET",
      }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: "push-subscription-reconcile-failed",
    });
    await expect(
      harness.retryCache.match(retryMarkerUrl),
    ).resolves.toBeInstanceOf(Response);
  });

  it("recreates and registers a missing subscription without an open app window", async () => {
    const applicationServerKey = new Uint8Array(65);
    applicationServerKey[0] = 4;
    const replacement = pushSubscription(
      "https://push.example.test/recreated",
    );
    const subscriptionId = `jbps_${"c".repeat(64)}`;
    const harness = createHarness({
      clients: [],
      subscribeResult: replacement,
      fetchResponse: new Response(JSON.stringify({ subscriptionId }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: null,
      oldSubscription: {
        ...pushSubscription("https://push.example.test/expired"),
        options: { applicationServerKey: applicationServerKey.buffer },
      },
    });

    expect(harness.pushManager.subscribe).toHaveBeenCalledWith({
      applicationServerKey,
      userVisibleOnly: true,
    });
    expect(harness.fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/push/subscriptions",
      expect.objectContaining({
        credentials: "include",
        method: "PUT",
      }),
    );
    await expect(
      harness.retryCache.match(retryMarkerUrl),
    ).resolves.toBeUndefined();
  });

  it("fetches the authenticated VAPID key when the old subscription has no usable key", async () => {
    const applicationServerKey = new Uint8Array(65);
    applicationServerKey[0] = 4;
    const publicKey = btoa(
      String.fromCharCode(...applicationServerKey),
    )
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    const subscriptionId = `jbps_${"e".repeat(64)}`;
    const harness = createHarness({
      subscribeResult: pushSubscription(
        "https://push.example.test/fetched-key",
      ),
      fetchResponses: [
        new Response(JSON.stringify({ publicKey }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        new Response(JSON.stringify({ subscriptionId }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ],
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: null,
      oldSubscription: null,
    });

    expect(harness.fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/push/vapid-public-key",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        method: "GET",
      }),
    );
    expect(harness.pushManager.subscribe).toHaveBeenCalledWith({
      applicationServerKey,
      userVisibleOnly: true,
    });
    expect(harness.fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/push/subscriptions",
      expect.objectContaining({
        credentials: "include",
        method: "PUT",
      }),
    );
  });

  it("persists a failed reconciliation and retries it when the app opens", async () => {
    const replacement = pushSubscription(
      "https://push.example.test/retry",
    );
    const subscriptionId = `jbps_${"d".repeat(64)}`;
    const harness = createHarness({
      pushSubscription: replacement,
      fetchResponses: [
        new Response(null, { status: 503 }),
        new Response(JSON.stringify({ subscriptionId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ],
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: replacement,
      oldSubscription: null,
    });

    await expect(
      harness.retryCache.match(retryMarkerUrl),
    ).resolves.toBeInstanceOf(Response);
    expect(harness.registerSync).toHaveBeenCalledWith(
      "jungle-bell-push-reconcile",
    );

    await harness.dispatch("message", {
      data: { type: "jungle-bell-app-open" },
    });

    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    await expect(
      harness.retryCache.match(retryMarkerUrl),
    ).resolves.toBeUndefined();
  });

  it.each([
    "DEVICE_SESSION_INVALID",
    "DEVICE_SESSION_REVOKED",
    "DEVICE_SESSION_EXPIRED",
    "DEVICE_SESSION_SCOPE_DENIED",
  ])("clears retry state after terminal mobile auth error %s", async (error) => {
    const replacement = pushSubscription(
      "https://push.example.test/session-ended",
    );
    const harness = createHarness({
      clients: [],
      pushSubscription: replacement,
      fetchResponse: new Response(JSON.stringify({ error }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: replacement,
      oldSubscription: null,
    });
    await harness.dispatch("message", {
      data: { type: "jungle-bell-app-open" },
    });

    expect(harness.fetchMock).toHaveBeenCalledOnce();
    await expect(
      harness.retryCache.match(retryMarkerUrl),
    ).resolves.toBeUndefined();
    expect(harness.registerSync).not.toHaveBeenCalled();
  });

  it("clears retry state for an endpoint owned by another active device", async () => {
    const replacement = pushSubscription(
      "https://push.example.test/owned",
    );
    const harness = createHarness({
      clients: [],
      pushSubscription: replacement,
      fetchResponse: new Response(
        JSON.stringify({ error: "PUSH_ENDPOINT_OWNED" }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    });

    await harness.dispatch("pushsubscriptionchange", {
      newSubscription: replacement,
      oldSubscription: null,
    });

    await expect(
      harness.retryCache.match(retryMarkerUrl),
    ).resolves.toBeUndefined();
    expect(harness.registerSync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "registration conflict",
      409,
      JSON.stringify({ error: "PUSH_SUBSCRIPTION_CONFLICT" }),
    ],
    ["not found", 404, JSON.stringify({ error: "NOT_FOUND" })],
    [
      "server unavailable",
      503,
      JSON.stringify({ error: "WEB_PUSH_NOT_CONFIGURED" }),
    ],
    ["invalid error response", 401, "not-json"],
    [
      "non-strict auth response",
      401,
      JSON.stringify({
        error: "DEVICE_SESSION_EXPIRED",
        detail: "must not influence retry classification",
      }),
    ],
    [
      "oversized error response",
      401,
      JSON.stringify({ error: "X".repeat(2_048) }),
    ],
    [
      "invalid success response",
      200,
      JSON.stringify({ unexpected: true }),
    ],
  ])(
    "keeps a durable closed-PWA retry marker for %s",
    async (_label, status, body) => {
      const replacement = pushSubscription(
        `https://push.example.test/retry-${status}`,
      );
      const harness = createHarness({
        clients: [],
        pushSubscription: replacement,
        fetchResponse: new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
      });

      await harness.dispatch("pushsubscriptionchange", {
        newSubscription: replacement,
        oldSubscription: null,
      });

      await expect(
        harness.retryCache.match(retryMarkerUrl),
      ).resolves.toBeInstanceOf(Response);
      expect(harness.registerSync).toHaveBeenCalledWith(
        "jungle-bell-push-reconcile",
      );
    },
  );
});
