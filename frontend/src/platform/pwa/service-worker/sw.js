import {ExpirationPlugin} from 'workbox-expiration';
import {cleanupOutdatedCaches, matchPrecache, precacheAndRoute} from 'workbox-precaching';
import {registerRoute} from 'workbox-routing';
import {NetworkFirst, NetworkOnly, StaleWhileRevalidate} from 'workbox-strategies';

const PUBLIC_DATA_CACHE = 'jungle-bell-public-data-v1';
const PUBLIC_IMAGE_CACHE = 'jungle-bell-public-images-v1';
const RUNTIME_ASSET_CACHE = 'jungle-bell-runtime-assets-v1';
const LEGACY_CACHE_PREFIX = 'jungle-bell-dashboard-';
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

const cacheableResponsePlugin = {
    async cacheWillUpdate({response}) {
        if (!response || !response.ok || response.type === 'opaque') return null;
        const cacheControl = response.headers.get('cache-control') || '';
        return cacheControl.toLowerCase().includes('no-store') ? null : response;
    },
};

const noHttpCachePlugin = {
    async requestWillFetch({request}) {
        return new Request(request, {cache: 'no-store'});
    },
};

function isEligibleGetRequest({request, sameOrigin}) {
    if (!sameOrigin || request.method !== 'GET') return false;
    return true;
}

function isPersonalRequest(request, url) {
    return (
        request.headers.has('authorization') ||
        (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/public/'))
    );
}

function isPublicCampusDataRequest(url) {
    return (
        url.pathname === '/api/public/status' ||
        url.pathname === '/api/public/laundry' ||
        url.pathname === '/api/public/meals' ||
        url.pathname === '/api/public/meals/history'
    );
}

const privateNetworkOnly = new NetworkOnly({plugins: [noHttpCachePlugin]});
registerRoute(
    ({request, url, sameOrigin}) =>
        isEligibleGetRequest({request, url, sameOrigin}) && isPersonalRequest(request, url),
    privateNetworkOnly,
);

registerRoute(
    ({request, url, sameOrigin}) =>
        isEligibleGetRequest({request, url, sameOrigin}) && request.mode === 'navigate',
    async ({request, url}) => {
        try {
            return await fetch(request);
        } catch {
            const appRootPath = new URL('./', self.registration.scope).pathname;
            const indexPath = new URL('./index.html', self.registration.scope).pathname;
            if (url.pathname === appRootPath || url.pathname === indexPath) {
                return (await matchPrecache('./index.html')) || Response.error();
            }
            return Response.error();
        }
    },
);

registerRoute(
    ({request, url, sameOrigin}) =>
        isEligibleGetRequest({request, url, sameOrigin}) && isPublicCampusDataRequest(url),
    new NetworkFirst({
        cacheName: PUBLIC_DATA_CACHE,
        networkTimeoutSeconds: 5,
        plugins: [
            cacheableResponsePlugin,
            new ExpirationPlugin({
                maxEntries: 128,
                maxAgeSeconds: SEVEN_DAYS_SECONDS,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

// Register the precache route before runtime asset routes so every revisioned
// dashboard and lazy chunk remains available immediately after installation.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('activate', (event) => {
    event.waitUntil(Promise.all([deleteLegacyCaches(), self.clients.claim()]));
});

async function deleteLegacyCaches() {
    const deletions = [];
    for (const key of await caches.keys()) {
        if (key.startsWith(LEGACY_CACHE_PREFIX)) deletions.push(caches.delete(key));
    }
    await Promise.all(deletions);
}

registerRoute(
    ({request, url, sameOrigin}) =>
        isEligibleGetRequest({request, url, sameOrigin}) && request.destination === 'image',
    new StaleWhileRevalidate({
        cacheName: PUBLIC_IMAGE_CACHE,
        plugins: [
            cacheableResponsePlugin,
            new ExpirationPlugin({
                maxEntries: 96,
                maxAgeSeconds: THIRTY_DAYS_SECONDS,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

registerRoute(
    ({request, url, sameOrigin}) =>
        isEligibleGetRequest({request, url, sameOrigin}) &&
        ['font', 'script', 'style', 'worker'].includes(request.destination),
    new StaleWhileRevalidate({
        cacheName: RUNTIME_ASSET_CACHE,
        plugins: [
            cacheableResponsePlugin,
            new ExpirationPlugin({
                maxEntries: 96,
                maxAgeSeconds: THIRTY_DAYS_SECONDS,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data?.json() || {};
    } catch {
        payload = {body: event.data?.text() || ''};
    }
    const expiresAtEpochMs = payload.expiresAtEpochMs;
    if (
        !Number.isSafeInteger(expiresAtEpochMs) ||
        expiresAtEpochMs < 0 ||
        Date.now() >= expiresAtEpochMs
    )
        return;
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'Jungle Bell';
    const body = typeof payload.body === 'string' ? payload.body.slice(0, 500) : '';
    const route =
        typeof payload.path === 'string'
            ? payload.path.match(
                  /^\/#\/?(attendance|laundry|meals|notifications|connections)$/u,
              )?.[1]
            : undefined;
    const path = route ? `/#/${route}` : '/#/notifications';
    const notificationTag =
        typeof payload.tag === 'string'
            ? payload.tag.slice(0, 120)
            : typeof payload.notificationId === 'string'
              ? payload.notificationId.slice(0, 120)
              : undefined;
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: './icons/icon-192.png',
            badge: './icons/icon-192.png',
            data: {path},
            tag: notificationTag,
        }),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const path = event.notification.data?.path || '/#/notifications';
    const target = new URL(path, self.location.origin).href;
    event.waitUntil(
        self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(async (clients) => {
            for (const client of clients) {
                if (new URL(client.url).origin === self.location.origin) {
                    await client.navigate(target);
                    return client.focus();
                }
            }
            return self.clients.openWindow(target);
        }),
    );
});
