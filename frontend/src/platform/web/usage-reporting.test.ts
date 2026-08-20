import {describe, expect, test, vi} from 'vitest';
import {reportWebUiOpened, startWebUsageReporting} from './usage-reporting';

describe('web usage reporting', () => {
    test('ordinary web uses only the anonymous allowlisted event', async () => {
        const fetcher = vi.fn(async () => new Response(null, {status: 204}));

        await reportWebUiOpened(false, fetcher);

        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledWith('/api/public/usage/ui-opened', expect.objectContaining({
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({client: 'web'}),
        }));
    });

    test('PWA uses its authenticated session and falls back only after 401', async () => {
        const connected = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(null, {status: 204}));
        await reportWebUiOpened(true, connected);
        expect(connected).toHaveBeenCalledTimes(1);
        expect(connected.mock.calls[0]?.[0]).toBe('/api/me/usage/ui-opened');

        let requestCount = 0;
        const disconnected = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            requestCount += 1;
            return new Response(null, {status: requestCount === 1 ? 401 : 204});
        });
        await reportWebUiOpened(true, disconnected);
        expect(disconnected.mock.calls.map(([path]) => path)).toEqual([
            '/api/me/usage/ui-opened',
            '/api/public/usage/ui-opened',
        ]);
        expect(disconnected.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({client: 'pwa'}));
    });

    test('reports initial and restored visibility without allowing overlapping requests', async () => {
        let visibilityState: DocumentVisibilityState = 'visible';
        let listener: (() => void) | undefined;
        let resolveRequest: (() => void) | undefined;
        const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
            resolveRequest = () => resolve(new Response(null, {status: 204}));
        }));
        const documentObject = {
            get visibilityState() { return visibilityState; },
            addEventListener: (_type: 'visibilitychange', value: () => void) => { listener = value; },
            removeEventListener: vi.fn(),
        };

        const stop = startWebUsageReporting({installedPwa: false, fetcher, documentObject});
        listener?.();
        expect(fetcher).toHaveBeenCalledTimes(1);
        resolveRequest?.();
        await Promise.resolve();
        await Promise.resolve();
        visibilityState = 'hidden';
        listener?.();
        visibilityState = 'visible';
        listener?.();
        expect(fetcher).toHaveBeenCalledTimes(2);
        stop();
        expect(documentObject.removeEventListener).toHaveBeenCalledWith('visibilitychange', listener);
    });
});
