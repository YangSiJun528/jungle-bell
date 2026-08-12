import {readFileSync} from 'node:fs';
import {describe, expect, test, vi} from 'vitest';
import {createDesktopHttpSessionManager} from './desktop-http-session';
import {createHttpApiClient} from './http-api-client';
import {hasOwn} from '@/lib/object';

const token = (character: string) => `jbui_${character.repeat(64)}`;
const json = (status = 200) => new Response('{}', {
    status,
    headers: {'content-type': 'application/json'},
});

function delayedJsonBody(body = '{}', status = 200) {
    let released = false;
    let release!: () => void;
    const bytes = new TextEncoder().encode(body);
    const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            release = () => {
                if (released) return;
                released = true;
                controller.enqueue(bytes);
                controller.close();
            };
        },
    }), {
        status,
        statusText: status === 200 ? 'Verified' : undefined,
        headers: {
            'content-type': 'application/json',
            'x-response-contract': 'preserved',
        },
    });
    return {release, response};
}

describe('desktop HTTP session', () => {
    test('keeps the short token out of browser storage and query caches', () => {
        const source = readFileSync(new URL('./desktop-http-session.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/localStorage|sessionStorage|QueryClient|setQueryData/u);
    });

    test('50 concurrent callers share one memory-only bootstrap', async () => {
        const bootstrapDesktopHttpSession = vi.fn(async () => ({
            accessToken: token('a'),
            expiresAt: new Date(420_000).toISOString(),
        }));
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession},
            now: () => 0,
        });

        const leases = await Promise.all(Array.from({length: 50}, () => manager.getSessionLease()));
        expect(leases.map((lease) => lease.accessToken))
            .toEqual(Array.from({length: 50}, () => token('a')));
        expect(new Set(leases.map((lease) => lease.generation))).toEqual(new Set([0]));
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(1);
    });

    test('refreshes proactively within 60 seconds of expiry', async () => {
        let now = 0;
        const bootstrapDesktopHttpSession = vi.fn()
            .mockResolvedValueOnce({accessToken: token('a'), expiresAt: new Date(120_001).toISOString()})
            .mockResolvedValueOnce({accessToken: token('b'), expiresAt: new Date(240_001).toISOString()});
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession},
            now: () => now,
        });

        await expect(manager.getSessionLease()).resolves.toMatchObject({accessToken: token('a'), generation: 0});
        now = 60_001;
        await expect(manager.getSessionLease()).resolves.toMatchObject({accessToken: token('b'), generation: 0});
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(2);
    });

    test('clear invalidates an in-flight bootstrap so an old identity token cannot return', async () => {
        let resolveFirst!: (value: {accessToken: string; expiresAt: string}) => void;
        const first = new Promise<{accessToken: string; expiresAt: string}>((resolve) => {
            resolveFirst = resolve;
        });
        const bootstrapDesktopHttpSession = vi.fn()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce({accessToken: token('b'), expiresAt: new Date(420_000).toISOString()});
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession},
            now: () => 0,
        });
        const oldIdentityRequest = manager.getSessionLease();

        manager.clear();
        resolveFirst({accessToken: token('a'), expiresAt: new Date(420_000).toISOString()});

        await expect(oldIdentityRequest).rejects.toThrow('DESKTOP_HTTP_SESSION_INVALIDATED');
        await expect(manager.getSessionLease()).resolves.toMatchObject({accessToken: token('b'), generation: 1});
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(2);
    });

    test('rejects non-exact, expired, or malformed bootstrap values', async () => {
        for (const value of [
            {accessToken: 'desktop-secret', expiresAt: new Date(420_000).toISOString()},
            {accessToken: token('a'), expiresAt: new Date(0).toISOString()},
            {accessToken: token('a'), expiresAt: 'soon'},
            {accessToken: token('a'), expiresAt: new Date(420_000).toISOString(), extra: true},
        ]) {
            const manager = createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession: async () => value as never},
                now: () => 0,
            });
            await expect(manager.getSessionLease()).rejects.toThrow('API_RESPONSE_INVALID');
        }
    });

    test('uses a Safari 13-compatible own-property boundary in session parsers', () => {
        const sourceUrls = [
            new URL('./desktop-http-session.ts', import.meta.url),
            new URL('./native-bridge.ts', import.meta.url),
            new URL('./desktop-settings.ts', import.meta.url),
            new URL('../features/connections/lib/pending-pairing.ts', import.meta.url),
        ];
        for (const sourceUrl of sourceUrls) {
            expect(readFileSync(sourceUrl, 'utf8')).not.toContain(['Object', 'hasOwn'].join('.'));
        }
        const nullPrototype = Object.create(null) as Record<string, unknown>;
        nullPrototype.value = true;
        expect(hasOwn(nullPrototype, 'value')).toBe(true);
        expect(hasOwn({hasOwnProperty: null}, 'hasOwnProperty')).toBe(true);
    });
});

describe('HTTP API boundaries', () => {
    test('separates public omit, companion cookies, and desktop bearer namespaces', async () => {
        const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push([input, init]);
            return json();
        });
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession: async () => ({
                accessToken: token('a'),
                expiresAt: new Date(420_000).toISOString(),
            })},
            now: () => 0,
        });
        const client = createHttpApiClient({
            fetcher,
            publicBase: 'https://data.example',
            platformBase: 'https://platform.example',
            desktopSession: manager,
        });

        const attemptedHeaders = {authorization: 'Bearer should-not-cross', cookie: 'manual=unsafe'};
        await client.publicResponse('/api/public/laundry', {headers: attemptedHeaders});
        await client.companionResponse('/api/mobile/attendance', {headers: attemptedHeaders});
        await client.desktopResponse('/api/desktop-ui/attendance', {headers: attemptedHeaders});

        const publicInit = calls[0]?.[1] as RequestInit;
        const companionInit = calls[1]?.[1] as RequestInit;
        const desktopInit = calls[2]?.[1] as RequestInit;
        expect(calls.map(([url]) => url)).toEqual([
            'https://data.example/api/public/laundry',
            'https://platform.example/api/mobile/attendance',
            'https://platform.example/api/desktop-ui/attendance',
        ]);
        expect(publicInit.credentials).toBe('omit');
        expect(companionInit.credentials).toBe('include');
        expect(desktopInit.credentials).toBe('omit');
        expect(desktopInit.cache).toBe('no-store');
        expect(desktopInit.redirect).toBe('error');
        expect(new Headers(publicInit.headers).has('authorization')).toBe(false);
        expect(new Headers(companionInit.headers).has('authorization')).toBe(false);
        expect(new Headers(desktopInit.headers).get('authorization')).toBe(`Bearer ${token('a')}`);
        expect(new Headers(publicInit.headers).has('cookie')).toBe(false);
        expect(new Headers(companionInit.headers).has('cookie')).toBe(false);
        expect(new Headers(desktopInit.headers).has('cookie')).toBe(false);
    });

    test('buffers a desktop response while preserving metadata and a fresh readable body', async () => {
        const upstream = new Response('{"accepted":true}', {
            status: 202,
            statusText: 'Accepted for processing',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'x-response-contract': 'preserved',
            },
        });
        const client = createHttpApiClient({
            fetcher: async () => upstream,
            publicBase: '',
            platformBase: '',
            desktopSession: createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession: async () => ({
                    accessToken: token('a'),
                    expiresAt: new Date(420_000).toISOString(),
                })},
                now: () => 0,
            }),
        });

        const response = await client.desktopResponse('/api/desktop-ui/attendance');

        expect(response).not.toBe(upstream);
        expect(upstream.bodyUsed).toBe(true);
        expect(response.bodyUsed).toBe(false);
        expect(response.body).not.toBeNull();
        expect(response.status).toBe(202);
        expect(response.statusText).toBe('Accepted for processing');
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(response.headers.get('x-response-contract')).toBe('preserved');
        await expect(response.text()).resolves.toBe('{"accepted":true}');
        expect(response.bodyUsed).toBe(true);
    });

    test('preserves null and zero-length desktop response bodies', async () => {
        const nullBody = new Response(null, {
            status: 204,
            statusText: 'No Content',
            headers: {'x-response-contract': 'null'},
        });
        const zeroLengthBody = new Response(new Uint8Array(), {
            status: 200,
            statusText: 'Empty',
            headers: {'x-response-contract': 'zero-length'},
        });
        const fetcher = vi.fn()
            .mockResolvedValueOnce(nullBody)
            .mockResolvedValueOnce(zeroLengthBody);
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession: async () => ({
                    accessToken: token('a'),
                    expiresAt: new Date(420_000).toISOString(),
                })},
                now: () => 0,
            }),
        });

        const verifiedNullBody = await client.desktopResponse('/api/desktop-ui/mobile-sessions');
        const verifiedZeroLengthBody = await client.desktopResponse('/api/desktop-ui/attendance');

        expect(verifiedNullBody.status).toBe(204);
        expect(verifiedNullBody.statusText).toBe('No Content');
        expect(verifiedNullBody.headers.get('x-response-contract')).toBe('null');
        expect(verifiedNullBody.body).toBeNull();
        expect(verifiedNullBody.bodyUsed).toBe(false);
        await expect(verifiedNullBody.text()).resolves.toBe('');
        expect(verifiedZeroLengthBody.status).toBe(200);
        expect(verifiedZeroLengthBody.statusText).toBe('Empty');
        expect(verifiedZeroLengthBody.headers.get('x-response-contract')).toBe('zero-length');
        expect(verifiedZeroLengthBody.body).not.toBeNull();
        expect(verifiedZeroLengthBody.bodyUsed).toBe(false);
        await expect(verifiedZeroLengthBody.arrayBuffer()).resolves.toHaveProperty('byteLength', 0);
    });

    test('rejects namespace prefix bypass and traversal before fetch or bootstrap', async () => {
        const fetcher = vi.fn(async () => json());
        const bootstrapDesktopHttpSession = vi.fn(async () => ({
            accessToken: token('a'),
            expiresAt: new Date(420_000).toISOString(),
        }));
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession},
                now: () => 0,
            }),
        });

        await expect(client.desktopResponse('/api/desktop-ui/../desktop' as never))
            .rejects.toThrow('API_CLIENT_INVALID_ARGUMENT');
        expect(() => client.companionResponse('/api/mobile-evil/attendance' as never))
            .toThrow('API_CLIENT_INVALID_ARGUMENT');
        expect(fetcher).not.toHaveBeenCalled();
        expect(bootstrapDesktopHttpSession).not.toHaveBeenCalled();
    });

    test('50 concurrent 401 responses cause one refresh and one retry each', async () => {
        let generation = 0;
        const bootstrapDesktopHttpSession = vi.fn(async () => {
            generation += 1;
            return {
                accessToken: token(generation === 1 ? 'a' : 'b'),
                expiresAt: new Date(420_000).toISOString(),
            };
        });
        const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
            new Headers(init?.headers).get('authorization') === `Bearer ${token('a')}`
                ? json(401)
                : json());
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession},
                now: () => 0,
            }),
        });

        const responses = await Promise.all(Array.from(
            {length: 50},
            () => client.desktopResponse('/api/desktop-ui/attendance'),
        ));
        expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(2);
        expect(fetcher).toHaveBeenCalledTimes(100);
    });

    test('discards a GET body that completes after identity reset', async () => {
        const delayed = delayedJsonBody('{"attendance":{"private":true}}');
        const fetcher = vi.fn(async () => delayed.response);
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession: async () => ({
                accessToken: token('a'),
                expiresAt: new Date(420_000).toISOString(),
            })},
            now: () => 0,
        });
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: manager,
        });

        const pending = client.desktopResponse('/api/desktop-ui/attendance', {method: 'GET'});
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(delayed.response.bodyUsed).toBe(true));
        manager.clear();
        const assertion = expect(pending).rejects.toThrow('DESKTOP_HTTP_SESSION_INVALIDATED');
        delayed.release();

        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('discards a PUT body that completes after identity reset', async () => {
        const delayed = delayedJsonBody('{"enabled":true}');
        const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => delayed.response);
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession: async () => ({
                accessToken: token('a'),
                expiresAt: new Date(420_000).toISOString(),
            })},
            now: () => 0,
        });
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: manager,
        });

        const pending = client.desktopResponse('/api/desktop-ui/meal-preferences', {
            method: 'PUT',
            body: JSON.stringify({enabled: true}),
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(delayed.response.bodyUsed).toBe(true));
        manager.clear();
        const assertion = expect(pending).rejects.toThrow('DESKTOP_HTTP_SESSION_INVALIDATED');
        delayed.release();

        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
            method: 'PUT',
            body: JSON.stringify({enabled: true}),
        });
    });

    test('never retries a pre-reset PUT 401 with the new identity lease', async () => {
        let resolveFirstResponse!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
            resolveFirstResponse = resolve;
        });
        const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => firstResponse);
        const bootstrapDesktopHttpSession = vi.fn()
            .mockResolvedValueOnce({accessToken: token('a'), expiresAt: new Date(420_000).toISOString()})
            .mockResolvedValueOnce({accessToken: token('b'), expiresAt: new Date(420_000).toISOString()});
        const manager = createDesktopHttpSessionManager({
            nativeBridge: {bootstrapDesktopHttpSession},
            now: () => 0,
        });
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: manager,
        });

        const pending = client.desktopResponse('/api/desktop-ui/meal-preferences', {
            method: 'PUT',
            body: JSON.stringify({enabled: true}),
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        manager.clear();
        await expect(manager.getSessionLease()).resolves.toMatchObject({
            accessToken: token('b'),
            generation: 1,
        });
        const assertion = expect(pending).rejects.toThrow('DESKTOP_HTTP_SESSION_INVALIDATED');
        resolveFirstResponse(json(401));

        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
            method: 'PUT',
            body: JSON.stringify({enabled: true}),
        });
    });

    test.each([403, 500])('does not refresh or retry HTTP %s', async (status) => {
        const bootstrapDesktopHttpSession = vi.fn(async () => ({
            accessToken: token('a'),
            expiresAt: new Date(420_000).toISOString(),
        }));
        const fetcher = vi.fn(async () => json(status));
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession},
                now: () => 0,
            }),
        });

        await expect(client.desktopResponse('/api/desktop-ui/attendance'))
            .resolves.toMatchObject({status});
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(1);
    });

    test('does not retry network failure', async () => {
        const bootstrapDesktopHttpSession = vi.fn(async () => ({
            accessToken: token('a'),
            expiresAt: new Date(420_000).toISOString(),
        }));
        const fetcher = vi.fn(async () => { throw new TypeError('offline'); });
        const client = createHttpApiClient({
            fetcher,
            publicBase: '',
            platformBase: '',
            desktopSession: createDesktopHttpSessionManager({
                nativeBridge: {bootstrapDesktopHttpSession},
                now: () => 0,
            }),
        });

        await expect(client.desktopResponse('/api/desktop-ui/attendance')).rejects.toThrow('offline');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(bootstrapDesktopHttpSession).toHaveBeenCalledTimes(1);
    });
});
