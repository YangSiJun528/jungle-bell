const LEGACY_APP_SHELL_CACHE_PREFIX = "jungle-bell-shell-";
const MAX_PUSH_PAYLOAD_BYTES = 2_048;
const NETWORK_TIMEOUT_MS = 15_000;
const PUSH_PAYLOAD_KEYS = new Set([
  "version",
  "title",
  "body",
  "path",
  "tag",
]);
const DEFAULT_PUSH_PAYLOAD = Object.freeze({
  version: 1,
  title: "Jungle Bell",
  body: "새로운 알림이 있습니다.",
  path: "/app",
  tag: "jungle-bell",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeInternalPath(path) {
  return (
    typeof path === "string" &&
    path.length >= 1 &&
    path.length <= 512 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !/%5c/iu.test(path) &&
    !/[\u0000-\u001f\u007f]/u.test(path)
  );
}

function isStrictPushPayload(payload) {
  if (!isPlainObject(payload)) {
    return false;
  }

  const keys = Object.keys(payload);
  if (
    keys.length !== PUSH_PAYLOAD_KEYS.size ||
    keys.some((key) => !PUSH_PAYLOAD_KEYS.has(key))
  ) {
    return false;
  }

  return (
    payload.version === 1 &&
    typeof payload.title === "string" &&
    payload.title.length >= 1 &&
    payload.title.length <= 80 &&
    payload.title === payload.title.trim() &&
    typeof payload.body === "string" &&
    payload.body.length >= 1 &&
    payload.body.length <= 240 &&
    payload.body === payload.body.trim() &&
    isSafeInternalPath(payload.path) &&
    typeof payload.tag === "string" &&
    payload.tag.length >= 1 &&
    payload.tag.length <= 64 &&
    /^[A-Za-z0-9:_-]+$/u.test(payload.tag)
  );
}

function parsePushPayload(data) {
  if (!data) {
    return DEFAULT_PUSH_PAYLOAD;
  }

  try {
    const raw = data.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PUSH_PAYLOAD_BYTES) {
      return DEFAULT_PUSH_PAYLOAD;
    }

    const payload = JSON.parse(raw);
    return isStrictPushPayload(payload) ? payload : DEFAULT_PUSH_PAYLOAD;
  } catch {
    return DEFAULT_PUSH_PAYLOAD;
  }
}

function resolveInternalUrl(value) {
  try {
    if (
      typeof value !== "string" ||
      value.includes("\\") ||
      /%5c/iu.test(value) ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new TypeError("Unsafe notification URL");
    }

    if (value.startsWith("/") && !isSafeInternalPath(value)) {
      throw new TypeError("Unsafe notification path");
    }

    const url = new URL(value, self.location.origin);
    if (
      url.origin !== self.location.origin ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new TypeError("Cross-origin notification URL");
    }
    return url.href;
  } catch {
    return new URL(DEFAULT_PUSH_PAYLOAD.path, self.location.origin).href;
  }
}

function isSameOriginClient(client) {
  try {
    return new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    if (typeof client.postMessage === "function" && isSameOriginClient(client)) {
      client.postMessage(message);
    }
  }
}

async function fetchWithTimeout(input, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    NETWORK_TIMEOUT_MS,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function reconcileChangedPushSubscription(subscription) {
  if (!subscription) {
    await notifyClients({ type: "push-subscription-invalidated" });
    return;
  }
  try {
    const serialized = subscription.toJSON();
    const response = await fetchWithTimeout("/api/push/subscriptions", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: serialized.endpoint,
        expirationTime: serialized.expirationTime ?? null,
        keys: serialized.keys,
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    const body = await response.json();
    if (
      !isPlainObject(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.subscriptionId !== "string" ||
      !/^jbps_[0-9a-f]{64}$/u.test(body.subscriptionId)
    ) {
      throw new TypeError("Invalid subscription response");
    }
    await notifyClients({
      type: "push-subscription-reconciled",
      subscriptionId: body.subscriptionId,
    });
  } catch {
    await notifyClients({ type: "push-subscription-reconcile-failed" });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) =>
              key.startsWith(LEGACY_APP_SHELL_CACHE_PREFIX),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data);

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/badge.svg",
      tag: payload.tag,
      data: { url: resolveInternalUrl(payload.path) },
    }),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(reconcileChangedPushSubscription(event.newSubscription));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = resolveInternalUrl(event.notification.data?.url);

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const existing = clients.find(isSameOriginClient);
        if (existing) {
          await existing.navigate(url);
          return existing.focus();
        }
        return self.clients.openWindow(url);
      }),
  );
});
