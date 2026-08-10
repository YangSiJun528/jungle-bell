const CACHE_VERSION = 'jungle-bell-dashboard-v1';
const APP_SHELL = [
  './dashboard.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const PERSONAL_API_PATHS = [
  '/v1/attendance/',
  '/v1/devices',
  '/v1/mobile/',
  '/v1/notifications/',
  '/v1/pairing-claims',
  '/v1/pairings/',
  '/v1/push/',
];

function sameOriginUrl(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin ? url : null;
}

function isPersonalRequest(request, url) {
  return request.headers.has('authorization')
    || PERSONAL_API_PATHS.some((path) => url.pathname.startsWith(path));
}

function responseCanBeCached(response) {
  if (!response || !response.ok || response.type === 'opaque') return false;
  const cacheControl = response.headers.get('cache-control') || '';
  return !cacheControl.toLowerCase().includes('no-store');
}

async function cachedDashboard() {
  const cache = await caches.open(CACHE_VERSION);
  return cache.match('./dashboard.html');
}

async function navigationResponse(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok) return response;
    if (url.pathname.endsWith('/pair') || url.pathname.endsWith('/app')) {
      return (await cachedDashboard()) || response;
    }
    return response;
  } catch {
    return (await cachedDashboard()) || Response.error();
  }
}

async function publicApiResponse(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (responseCanBeCached(response)) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

async function assetResponse(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (responseCanBeCached(response)) await cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await update) || Response.error();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = sameOriginUrl(request);
  if (!url) return;
  if (isPersonalRequest(request, url)) {
    event.respondWith(fetch(request, {cache: 'no-store'}));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request, url));
    return;
  }
  if (url.pathname.startsWith('/v1/laundry/') || url.pathname === '/v1/meals') {
    event.respondWith(publicApiResponse(request));
    return;
  }
  event.respondWith(assetResponse(request));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = {body: event.data?.text() || ''};
  }
  const expiresAtEpochMs = payload.expiresAtEpochMs;
  if (!Number.isSafeInteger(expiresAtEpochMs)
    || expiresAtEpochMs < 0
    || Date.now() >= expiresAtEpochMs) return;
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'Jungle Bell';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 500) : '';
  const path = typeof payload.path === 'string'
    && /^\/dashboard\.html#(?:attendance|laundry|meals|notifications|connections)$/u.test(payload.path)
    ? payload.path
    : '/dashboard.html#notifications';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: {path},
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 120) : undefined,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.path || '/dashboard.html#notifications';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(async (clients) => {
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
