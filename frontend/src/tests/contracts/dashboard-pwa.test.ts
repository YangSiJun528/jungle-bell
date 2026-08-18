import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const manifest = JSON.parse(
    readFileSync(new URL('./platform/pwa/public/manifest.webmanifest', srcRoot), 'utf8'),
) as Record<string, unknown>;
const dashboardApi = readFileSync(new URL('./api/dashboard-api.ts', srcRoot), 'utf8');
const worker = readFileSync(new URL('./platform/pwa/service-worker/sw.js', srcRoot), 'utf8');
const pwaAdapter = readFileSync(new URL('./platform/pwa/adapter.ts', srcRoot), 'utf8');
const headers = readFileSync(new URL('./platform/pwa/public/_headers', srcRoot), 'utf8');
const webIcon = readFileSync(new URL('./platform/pwa/public/icons/icon.svg', srcRoot), 'utf8');
const vite = readFileSync(new URL('../vite.config.ts', srcRoot), 'utf8');

test('manifest는 모바일 standalone 설치와 최소 아이콘을 선언한다', () => {
    assert.equal(manifest.name, 'Jungle Bell');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.id, './');
    assert.equal(manifest.start_url, './#/home');
    assert.equal(manifest.scope, './');
    assert.ok(Array.isArray(manifest.icons));
    assert.ok((manifest.icons as Array<{sizes?: string}>).some(({sizes}) => sizes === '192x192'));
    assert.ok((manifest.icons as Array<{sizes?: string}>).some(({sizes}) => sizes === '512x512'));
});

test('PWA 아이콘과 웹 파비콘은 정글벨 나침반 심볼을 공유한다', () => {
    assert.match(vite, /rel=\"icon\" href=\"\.\/icons\/icon-32\.png\" type=\"image\/png\" sizes=\"32x32\"/);
    assert.match(vite, /rel=\"icon\" href=\"\.\/icons\/icon\.svg\" type=\"image\/svg\+xml\"/);
    assert.match(webIcon, /fill="#00CF8A"/);
    assert.match(webIcon, /M512 896a384 384 0 1 0 0-768/);
    assert.match(webIcon, /M725\.888 315\.008C676\.48 428\.672/);
});

test('service worker는 Workbox revision manifest를 선캐시하고 개인 API·인증 요청은 캐시하지 않는다', () => {
    assert.match(worker, /from ['"]workbox-precaching['"]/);
    assert.match(worker, /precacheAndRoute\(self\.__WB_MANIFEST\)/);
    assert.match(worker, /cleanupOutdatedCaches\(\)/);
    assert.doesNotMatch(worker, /__BUILD_ID__|sw-assets\.json|cache\.addAll/);
    assert.match(worker, /url\.pathname\.startsWith\(['"]\/api\/['"]\)/);
    assert.match(worker, /!url\.pathname\.startsWith\(['"]\/api\/public\/['"]\)/);
    assert.match(worker, /authorization/i);
    assert.match(worker, /new NetworkOnly/);
    assert.match(worker, /cache-control/i);
    assert.match(worker, /no-store/i);
    assert.doesNotMatch(worker, /\/api\/private\/[^'"`]*['"`]\s*,/);
    assert.doesNotMatch(worker, /endsWith\(['"]\/(?:pair|app)['"]\)/);
    assert.match(worker, /url\.pathname\s*===\s*appRootPath\s*\|\|\s*url\.pathname\s*===\s*indexPath/);
    assert.match(worker, /matchPrecache\(['"]\.\/index\.html['"]\)/);
});

test('공개 상태·세탁·급식 API는 과거 급식 페이지까지 network-first 정책을 사용한다', () => {
    assert.match(worker, /function isPublicCampusDataRequest\(url\)/);
    assert.match(worker, /url\.pathname === ['"]\/api\/public\/status['"]/);
    assert.match(worker, /url\.pathname === ['"]\/api\/public\/laundry['"]/);
    assert.match(worker, /url\.pathname === ['"]\/api\/public\/meals['"]/);
    assert.match(worker, /url\.pathname === ['"]\/api\/public\/meals\/history['"]/);
    assert.match(worker, /new NetworkFirst/);
    assert.match(worker, /networkTimeoutSeconds:\s*\d+/);
    assert.match(worker, /cacheName:\s*PUBLIC_DATA_CACHE[\s\S]*new ExpirationPlugin\(\{[\s\S]*maxEntries:\s*\d+/);
    assert.match(worker, /maxAgeSeconds:\s*SEVEN_DAYS_SECONDS/);
});

test('새 service worker는 기존 React client가 닫힐 때까지 waiting 상태를 유지한다', () => {
    assert.doesNotMatch(worker, /\bskipWaiting\s*\(/);
    assert.doesNotMatch(pwaAdapter, /SKIP_WAITING|registration\.waiting\.postMessage/);
    assert.match(worker, /cleanupOutdatedCaches\(\)/);
    assert.match(worker, /LEGACY_CACHE_PREFIX\s*=\s*['"]jungle-bell-dashboard-['"]/);
    assert.match(worker, /self\.addEventListener\(['"]activate['"]/);
    assert.match(worker, /key\.startsWith\(LEGACY_CACHE_PREFIX\)/);
    assert.doesNotMatch(pwaAdapter, /skipWaiting/);
});

test('같은 출처 공개 이미지는 만료 한도가 있는 stale-while-revalidate 캐시를 사용한다', () => {
    assert.match(worker, /request\.destination === ['"]image['"]/);
    assert.match(worker, /new StaleWhileRevalidate/);
    assert.match(worker, /new ExpirationPlugin/);
    assert.match(worker, /maxEntries:\s*\d+/);
    assert.match(worker, /maxAgeSeconds:\s*THIRTY_DAYS_SECONDS/);
    assert.ok(
        worker.indexOf('precacheAndRoute(self.__WB_MANIFEST)')
            < worker.indexOf("request.destination === 'image'"),
        'precache route must win for built images and lazy chunks',
    );
});

test('프론트엔드 API와 PWA 계약에 기존 v1 경로가 남지 않는다', () => {
    assert.equal(dashboardApi.includes('/v1'), false);
    assert.equal(worker.includes('/v1'), false);
});

test('service worker는 루트와 index.html만 오프라인 SPA 진입점으로 사용한다', () => {
    assert.match(worker, /new URL\(['"]\.\/['"], self\.registration\.scope\)/);
    assert.match(worker, /new URL\(['"]\.\/index\.html['"], self\.registration\.scope\)/);
    assert.doesNotMatch(worker, /isBlogRequest|dashboard\.html/);
});

test('service worker는 만료되었거나 유효한 safe epoch가 없는 push를 표시하지 않는다', async () => {
    type WorkerListener = (event: {
        data?: {json(): unknown};
        waitUntil(promise: Promise<unknown>): void;
    }) => void;
    const listeners = new Map<string, WorkerListener>();
    const shown: unknown[] = [];
    const workerSelf = {
        __WB_MANIFEST: [],
        addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
        registration: {
            showNotification: async (...args: unknown[]) => { shown.push(args); },
        },
        location: {origin: 'https://jungle-bell.example'},
        clients: {},
    };
    const executableWorker = worker.replace(
        /^import[\s\S]*?from ['"][^'"]+['"];\n/gmu,
        '',
    );
    runInNewContext(executableWorker, {
        self: workerSelf,
        fetch: async () => new Response(),
        URL,
        Request,
        Response,
        Headers,
        Date,
        precacheAndRoute: () => undefined,
        cleanupOutdatedCaches: () => undefined,
        registerRoute: () => undefined,
        NetworkFirst: class {},
        NetworkOnly: class {},
        StaleWhileRevalidate: class {},
        ExpirationPlugin: class {},
    });
    const push = listeners.get('push');
    assert.ok(push);

    for (const expiresAtEpochMs of [Date.now() - 1, undefined, Number.MAX_SAFE_INTEGER + 1]) {
        const waits: Promise<unknown>[] = [];
        push({
            data: {json: () => ({title: '만료 알림', expiresAtEpochMs})},
            waitUntil: (promise) => waits.push(promise),
        });
        await Promise.all(waits);
    }
    assert.equal(shown.length, 0);

    const waits: Promise<unknown>[] = [];
    push({
        data: {json: () => ({
            notificationId: 'notification-1',
            title: '유효 알림',
            expiresAtEpochMs: Date.now() + 60_000,
        })},
        waitUntil: (promise) => waits.push(promise),
    });
    await Promise.all(waits);
    assert.equal(shown.length, 1);
    assert.equal((shown[0] as [string, {tag?: string}])[1].tag, 'notification-1');
    assert.equal((shown[0] as [string, {data?: {path?: string}}])[1].data?.path, '/#/notifications');

    const routeWaits: Promise<unknown>[] = [];
    push({
        data: {json: () => ({
            title: '출석 알림',
            path: '/#attendance',
            expiresAtEpochMs: Date.now() + 60_000,
        })},
        waitUntil: (promise) => routeWaits.push(promise),
    });
    await Promise.all(routeWaits);
    assert.equal((shown[1] as [string, {data?: {path?: string}}])[1].data?.path, '/#/attendance');
});

test('Vite는 표준 index.html 엔트리와 PWA public 디렉터리를 빌드한다', () => {
    assert.match(vite, /src\/platform\/pwa\/public/);
    assert.doesNotMatch(vite, /rolldownOptions[\s\S]*input:/);
    assert.match(vite, /VitePWA\(\{/);
    assert.match(vite, /strategies:\s*['"]injectManifest['"]/);
    assert.match(vite, /srcDir:\s*['"]src\/platform\/pwa\/service-worker['"]/);
    assert.match(vite, /filename:\s*['"]sw\.js['"]/);
    assert.match(vite, /injectRegister:\s*false/);
    assert.match(vite, /manifest:\s*false/);
    assert.match(vite, /globPatterns:[\s\S]*index\.html/);
    assert.doesNotMatch(vite, /serviceWorkerAssetsPlugin|sw-assets\.json|__BUILD_ID__/);
});

test('공개 정적 앱은 QR fragment와 개인 화면을 위한 최소 보안 헤더를 선언한다', () => {
    assert.match(headers, /Content-Security-Policy:/);
    assert.match(headers, /object-src 'none'/);
    assert.match(headers, /frame-ancestors 'none'/);
    assert.match(headers, /base-uri 'none'/);
    assert.match(headers, /Referrer-Policy: no-referrer/);
    assert.match(headers, /X-Content-Type-Options: nosniff/);
    assert.match(headers, /Permissions-Policy:/);
    assert.match(headers, /\/sw\.js[\s\S]*Cache-Control: no-cache, no-store/);
    assert.match(headers, /\/manifest\.webmanifest[\s\S]*max-age=3600/);
});
