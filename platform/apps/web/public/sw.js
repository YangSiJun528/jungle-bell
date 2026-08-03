const LEGACY_APP_SHELL_CACHE_PREFIX = "jungle-bell-shell-";
const PUSH_RECONCILE_CACHE = "jungle-bell-push-reconcile-v1";
const PUSH_RECONCILE_MARKER_PATH =
  "/.jungle-bell/push-reconcile-pending";
const PUSH_RECONCILE_SYNC_TAG = "jungle-bell-push-reconcile";
const VAPID_PUBLIC_KEY_PATH = "/api/push/vapid-public-key";
const PUSH_SUBSCRIPTIONS_PATH = "/api/push/subscriptions";
const MAX_PUSH_PAYLOAD_BYTES = 2_048;
const MAX_RECONCILE_ERROR_BYTES = 1_024;
const NETWORK_TIMEOUT_MS = 15_000;
const TERMINAL_MOBILE_AUTH_ERRORS = new Set([
  "DEVICE_SESSION_INVALID",
  "DEVICE_SESSION_REVOKED",
  "DEVICE_SESSION_EXPIRED",
  "DEVICE_SESSION_SCOPE_DENIED",
]);
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

function retryMarkerUrl() {
  return new URL(
    PUSH_RECONCILE_MARKER_PATH,
    self.location.origin,
  ).href;
}

async function storePushReconcileRetry() {
  const cache = await caches.open(PUSH_RECONCILE_CACHE);
  await cache.put(
    retryMarkerUrl(),
    new Response("pending", {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    }),
  );
}

async function hasPushReconcileRetry() {
  const cache = await caches.open(PUSH_RECONCILE_CACHE);
  return (await cache.match(retryMarkerUrl())) !== undefined;
}

async function clearPushReconcileRetry() {
  const cache = await caches.open(PUSH_RECONCILE_CACHE);
  await cache.delete(retryMarkerUrl());
}

async function readBoundedErrorResponse(response) {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" || response.body === null) {
    return null;
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_RECONCILE_ERROR_BYTES
  ) {
    try {
      await response.body.cancel();
    } catch {
      // The response is already classified as untrusted and retryable.
    }
    return null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_RECONCILE_ERROR_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already classified as untrusted and retryable.
        }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function parseStrictApiErrorCode(response) {
  const raw = await readBoundedErrorResponse(response);
  if (raw === null) {
    return null;
  }
  try {
    const body = JSON.parse(raw);
    if (
      !isPlainObject(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.error !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(body.error)
    ) {
      return null;
    }
    return body.error;
  } catch {
    return null;
  }
}

async function reconciliationHttpError(response) {
  const errorCode = await parseStrictApiErrorCode(response);
  const terminalAuthError =
    (response.status === 401 || response.status === 403) &&
    TERMINAL_MOBILE_AUTH_ERRORS.has(errorCode);
  const endpointOwned =
    response.status === 409 && errorCode === "PUSH_ENDPOINT_OWNED";
  const error = new Error("PUSH_RECONCILE_HTTP_ERROR");
  error.name = terminalAuthError || endpointOwned
    ? "TerminalPushReconcileError"
    : "RetryablePushReconcileError";
  return error;
}

function isTerminalReconciliationError(error) {
  return (
    error instanceof Error &&
    error.name === "TerminalPushReconcileError"
  );
}

function readApplicationServerKey(subscription) {
  const value = subscription?.options?.applicationServerKey;
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) {
    return null;
  }
  return new Uint8Array(value.slice(0));
}

function decodeVapidPublicKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 80 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)
  ) {
    throw new TypeError("Invalid VAPID public key");
  }
  const unpadded = value.replace(/=+$/u, "");
  const base64 = unpadded.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new TypeError("Invalid VAPID public key");
  }
  return bytes;
}

async function fetchApplicationServerKey() {
  const response = await fetchWithTimeout(VAPID_PUBLIC_KEY_PATH, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw await reconciliationHttpError(response);
  }
  const body = await response.json();
  if (
    !isPlainObject(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.publicKey !== "string"
  ) {
    throw new TypeError("Invalid VAPID key response");
  }
  return decodeVapidPublicKey(body.publicKey);
}

async function obtainPushSubscription(
  preferredSubscription,
  previousSubscription,
) {
  if (preferredSubscription) {
    return preferredSubscription;
  }
  const existing =
    await self.registration.pushManager.getSubscription();
  if (existing) {
    return existing;
  }
  const previousApplicationServerKey =
    readApplicationServerKey(previousSubscription);
  const applicationServerKey =
    previousApplicationServerKey ??
    (await fetchApplicationServerKey());
  return self.registration.pushManager.subscribe({
    applicationServerKey,
    userVisibleOnly: true,
  });
}

function serializePushSubscription(subscription) {
  if (!subscription || typeof subscription.toJSON !== "function") {
    throw new TypeError("Invalid Push subscription");
  }
  const serialized = subscription.toJSON();
  if (
    !isPlainObject(serialized) ||
    typeof serialized.endpoint !== "string" ||
    !isPlainObject(serialized.keys) ||
    typeof serialized.keys.auth !== "string" ||
    typeof serialized.keys.p256dh !== "string"
  ) {
    throw new TypeError("Invalid Push subscription");
  }
  return {
    endpoint: serialized.endpoint,
    expirationTime: serialized.expirationTime ?? null,
    keys: {
      auth: serialized.keys.auth,
      p256dh: serialized.keys.p256dh,
    },
  };
}

async function registerCurrentPushSubscription(subscription) {
  const serialized = serializePushSubscription(subscription);
  const response = await fetchWithTimeout(PUSH_SUBSCRIPTIONS_PATH, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serialized),
  });
  if (!response.ok) {
    throw await reconciliationHttpError(response);
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
  return body.subscriptionId;
}

async function schedulePushReconcileRetry() {
  try {
    await storePushReconcileRetry();
  } catch {
    // Cache Storage can be unavailable under storage pressure. Background
    // Sync is still worth requesting as a best-effort retry path.
  }
  try {
    if (typeof self.registration.sync?.register === "function") {
      await self.registration.sync.register(PUSH_RECONCILE_SYNC_TAG);
    }
  } catch {
    // Safari does not support Background Sync and browsers can reject it.
    // activate, push, and app-open still retry the durable marker.
  }
}

async function reconcileChangedPushSubscription(
  preferredSubscription,
  previousSubscription,
) {
  try {
    await storePushReconcileRetry();
  } catch {
    // Continue the network attempt when Cache Storage is unavailable.
  }
  try {
    const subscription = await obtainPushSubscription(
      preferredSubscription,
      previousSubscription,
    );
    const subscriptionId =
      await registerCurrentPushSubscription(subscription);
    await clearPushReconcileRetry();
    await notifyClients({
      type: "push-subscription-reconciled",
      subscriptionId,
    });
  } catch (error) {
    if (isTerminalReconciliationError(error)) {
      try {
        await clearPushReconcileRetry();
      } catch {
        // A terminal authenticated response must not schedule another retry.
      }
      await notifyClients({ type: "push-subscription-invalidated" });
      return;
    }
    await schedulePushReconcileRetry();
    await notifyClients({ type: "push-subscription-reconcile-failed" });
  }
}

async function retryPendingPushReconciliation() {
  try {
    if (!(await hasPushReconcileRetry())) {
      return;
    }
  } catch {
    return;
  }
  await reconcileChangedPushSubscription(null, null);
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
      .then(() => self.clients.claim())
      .then(() => retryPendingPushReconciliation()),
  );
});

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data);

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: "/icon-192.png",
        badge: "/badge.svg",
        tag: payload.tag,
        data: { url: resolveInternalUrl(payload.path) },
      }),
      retryPendingPushReconciliation(),
    ]),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    reconcileChangedPushSubscription(
      event.newSubscription,
      event.oldSubscription,
    ),
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag === PUSH_RECONCILE_SYNC_TAG) {
    event.waitUntil(retryPendingPushReconciliation());
  }
});

self.addEventListener("message", (event) => {
  if (
    isPlainObject(event.data) &&
    event.data.type === "jungle-bell-app-open"
  ) {
    event.waitUntil(retryPendingPushReconciliation());
  }
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
