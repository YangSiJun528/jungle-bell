const CACHE_PREFIX = 'jungle-bell-dashboard-';
const CACHE_VERSION = 'jungle-bell-dashboard-__BUILD_ID__';
const GENERATED_ASSET_MANIFEST = './sw-assets.json?build=__BUILD_ID__';
const APP_SHELL = [
  './dashboard.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

async function generatedAppAssets() {
  const response = await fetch(GENERATED_ASSET_MANIFEST, {cache: 'no-store'});
  if (!response.ok) throw new Error('APP_ASSET_MANIFEST_UNAVAILABLE');
  const value = await response.json();
  if (!value || value.version !== 1 || !Array.isArray(value.assets) || value.assets.length > 256
    || value.assets.some((asset) => typeof asset !== 'string'
      || !/^\.\/assets\/[A-Za-z0-9_.-]+$/u.test(asset))) {
    throw new Error('APP_ASSET_MANIFEST_INVALID');
  }
  return value.assets;
}
function sameOriginUrl(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin ? url : null;
}

function isPersonalRequest(request, url) {
  return request.headers.has('authorization')
    || (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/public/'));
}

function isBlogRequest(url) {
  return url.pathname === '/blog' || url.pathname.startsWith('/blog/');
}

function isPublicCampusDataRequest(url) {
  return url.pathname === '/api/public/laundry'
    || url.pathname === '/api/public/meals'
    || url.pathname === '/api/public/meals/history';
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
    return response;
  } catch {
    const dashboardPath = new URL('./dashboard.html', self.registration.scope).pathname;
    return url.pathname === dashboardPath
      ? (await cachedDashboard()) || Response.error()
      : Response.error();
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
    generatedAppAssets()
      .then(async (assets) => {
        const cache = await caches.open(CACHE_VERSION);
        await cache.addAll([...APP_SHELL, ...assets]);
      }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = sameOriginUrl(request);
  if (!url) return;
  if (isBlogRequest(url)) return;
  if (isPersonalRequest(request, url)) {
    event.respondWith(fetch(request, {cache: 'no-store'}));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request, url));
    return;
  }
  if (isPublicCampusDataRequest(url)) {
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
  const notificationTag = typeof payload.tag === 'string'
    ? payload.tag.slice(0, 120)
    : typeof payload.notificationId === 'string'
      ? payload.notificationId.slice(0, 120)
      : undefined;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: {path},
    tag: notificationTag,
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
