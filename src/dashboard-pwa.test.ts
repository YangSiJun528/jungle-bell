import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'vitest';

const manifest = JSON.parse(
    readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const dashboardApi = readFileSync(new URL('./dashboard-api.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
const headers = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('manifest는 모바일 standalone 설치와 최소 아이콘을 선언한다', () => {
    assert.equal(manifest.name, 'Jungle Bell');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, './dashboard.html#home');
    assert.equal(manifest.scope, './');
    assert.ok(Array.isArray(manifest.icons));
    assert.ok((manifest.icons as Array<{sizes?: string}>).some(({sizes}) => sizes === '192x192'));
    assert.ok((manifest.icons as Array<{sizes?: string}>).some(({sizes}) => sizes === '512x512'));
});

test('service worker는 앱 셸만 선캐시하고 개인 API·인증 요청은 캐시하지 않는다', () => {
    assert.match(worker, /CACHE_PREFIX\s*=\s*['"]jungle-bell-dashboard-['"]/);
    assert.match(worker, /CACHE_VERSION\s*=\s*['"]jungle-bell-dashboard-0\.5\.0['"]/);
    assert.match(worker, /dashboard\.html/);
    assert.match(worker, /manifest\.webmanifest/);
    assert.doesNotMatch(worker, /APP_SHELL[\s\S]*?assets\/logo\.png[\s\S]*?\];/);
    assert.match(worker, /url\.pathname\.startsWith\(['"]\/api\/['"]\)/);
    assert.match(worker, /!url\.pathname\.startsWith\(['"]\/api\/public\/['"]\)/);
    assert.match(worker, /authorization/i);
    assert.match(worker, /request\.method\s*!==\s*['"]GET['"]/);
    assert.match(worker, /cache-control/i);
    assert.match(worker, /no-store/i);
    assert.doesNotMatch(worker, /\/api\/private\/[^'"`]*['"`]\s*,/);
    assert.doesNotMatch(worker, /endsWith\(['"]\/(?:pair|app)['"]\)/);
    assert.match(worker, /url\.pathname\s*===\s*dashboardPath/);
    assert.match(worker, /key\.startsWith\(CACHE_PREFIX\)/);
});

test('프론트엔드 API와 PWA 계약에 기존 v1 경로가 남지 않는다', () => {
    assert.equal(dashboardApi.includes('/v1'), false);
    assert.equal(worker.includes('/v1'), false);
});

test('service worker는 블로그 HTML과 정적 JSON 요청을 가로채지 않는다', () => {
    assert.match(worker, /function isBlogRequest\(url\)/);
    assert.match(worker, /url\.pathname\s*===\s*['"]\/blog['"]/);
    assert.match(worker, /url\.pathname\.startsWith\(['"]\/blog\/['"]\)/);
    assert.match(worker, /if \(isBlogRequest\(url\)\) return;/);
});

test('service worker는 만료되었거나 유효한 safe epoch가 없는 push를 표시하지 않는다', async () => {
    type WorkerListener = (event: {
        data?: {json(): unknown};
        waitUntil(promise: Promise<unknown>): void;
    }) => void;
    const listeners = new Map<string, WorkerListener>();
    const shown: unknown[] = [];
    const workerSelf = {
        addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
        registration: {
            showNotification: async (...args: unknown[]) => { shown.push(args); },
        },
        location: {origin: 'https://jungle-bell.example'},
        clients: {},
        skipWaiting: async () => undefined,
    };
    runInNewContext(worker, {
        self: workerSelf,
        caches: {},
        fetch: async () => new Response(),
        URL,
        Request,
        Response,
        Headers,
        Date,
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
});

test('Vite는 PWA public 디렉터리와 dashboard 멀티페이지 입력을 빌드한다', () => {
    assert.match(vite, /publicDir:\s*['"]public['"]/);
    assert.match(vite, /dashboard:\s*resolve\([^\n]*src\/dashboard\.html/);
    assert.doesNotMatch(vite, /pair:\s*resolve\(/);
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
