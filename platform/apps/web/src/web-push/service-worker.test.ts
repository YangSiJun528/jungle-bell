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
}

function createHarness(options: HarnessOptions = {}) {
  const origin = "https://app.example.test";
  const handlers = new Map<string, EventHandler>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const claimClients = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  const clients = options.clients ?? [];
  const fetchMock = vi.fn(async () =>
    options.fetchResponse ?? new Response(null, { status: 503 }),
  );
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
    registration: { showNotification },
    skipWaiting,
  };
  const cache = {
    addAll: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
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
    push,
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
    expect(harness.cacheStorage.open).not.toHaveBeenCalled();
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

  it("tells the app when a browser Push subscription disappears", async () => {
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

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "push-subscription-invalidated",
    });
  });
});
