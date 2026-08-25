import {describe, expect, test, vi} from 'vitest';

import {reportWebUiOpened, startWebUsageReporting} from './usage-reporting';

type UsageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type UsageRetryDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

function immediateDelay(recorded: number[]): UsageRetryDelay {
    return async (milliseconds) => {
        recorded.push(milliseconds);
    };
}

function abortablePendingDelay(): ReturnType<typeof vi.fn<UsageRetryDelay>> {
    return vi.fn<UsageRetryDelay>(
        (_milliseconds, signal) =>
            new Promise<void>((resolve) => {
                const finish = () => {
                    signal?.removeEventListener('abort', finish);
                    resolve();
                };
                if (signal?.aborted) {
                    finish();
                    return;
                }
                signal?.addEventListener('abort', finish, {once: true});
            }),
    );
}

function visibilityHarness(initial: DocumentVisibilityState = 'visible') {
    let visibilityState = initial;
    let listener: (() => void) | undefined;
    const removeEventListener = vi.fn<(type: 'visibilitychange', listener: () => void) => void>();
    const documentObject = {
        get visibilityState() {
            return visibilityState;
        },
        addEventListener: (_type: 'visibilitychange', value: () => void) => {
            listener = value;
        },
        removeEventListener,
    };

    return {
        documentObject,
        removeEventListener,
        emit(next: DocumentVisibilityState) {
            visibilityState = next;
            listener?.();
        },
        listener: () => listener,
    };
}

describe('web usage reporting', () => {
    test('ordinary web stops after a successful anonymous request', async () => {
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 204}));

        await reportWebUiOpened(false, fetcher);

        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledWith(
            '/api/public/usage/ui-opened',
            expect.objectContaining({
                method: 'POST',
                credentials: 'include',
                body: JSON.stringify({client: 'web'}),
            }),
        );
    });

    test('retries a rejected request and then stops after success', async () => {
        const delays: number[] = [];
        const fetcher = vi
            .fn<UsageFetch>()
            .mockRejectedValueOnce(new TypeError('network unavailable'))
            .mockResolvedValueOnce(new Response(null, {status: 204}));

        await reportWebUiOpened(false, fetcher, () => true, {
            delay: immediateDelay(delays),
        });

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(delays).toEqual([250]);
    });

    test('retries 502 and 504 with the bounded backoff', async () => {
        const delays: number[] = [];
        const statuses = [502, 504, 204];
        const fetcher = vi.fn<UsageFetch>(async () =>
            Promise.resolve(new Response(null, {status: statuses.shift()})),
        );

        await reportWebUiOpened(false, fetcher, () => true, {
            delay: immediateDelay(delays),
        });

        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([250, 1_000]);
    });

    test('caps 503 retries at three total attempts', async () => {
        const delays: number[] = [];
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 503}));

        await reportWebUiOpened(false, fetcher, () => true, {
            delay: immediateDelay(delays),
        });

        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([250, 1_000]);
    });

    test.each([400, 401, 403, 404, 409, 429, 500])('does not retry HTTP %i', async (status) => {
        const delays: number[] = [];
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status}));

        await reportWebUiOpened(false, fetcher, () => true, {
            delay: immediateDelay(delays),
        });

        expect(fetcher).toHaveBeenCalledOnce();
        expect(delays).toEqual([]);
    });

    test('PWA falls back to anonymous reporting only after authenticated 401', async () => {
        let requestCount = 0;
        const fetcher = vi.fn<UsageFetch>(async () => {
            requestCount += 1;
            return new Response(null, {status: requestCount === 1 ? 401 : 204});
        });

        await reportWebUiOpened(true, fetcher);

        expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
            '/api/me/usage/ui-opened',
            '/api/public/usage/ui-opened',
        ]);
        expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({client: 'pwa'}));
    });

    test('PWA does not fall back after authenticated 503 retries are exhausted', async () => {
        const delays: number[] = [];
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 503}));

        await reportWebUiOpened(true, fetcher, () => true, {
            delay: immediateDelay(delays),
        });

        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(fetcher.mock.calls.every(([path]) => path === '/api/me/usage/ui-opened')).toBe(true);
        expect(delays).toEqual([250, 1_000]);
    });

    test('PWA does not fall back after a non-retryable authenticated response', async () => {
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 500}));

        await reportWebUiOpened(true, fetcher);

        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0]?.[0]).toBe('/api/me/usage/ui-opened');
    });

    test('anonymous opt out sends no ordinary web request or disconnected PWA fallback', async () => {
        const web = vi.fn<UsageFetch>(async () => new Response(null, {status: 204}));
        await reportWebUiOpened(false, web, () => false);
        expect(web).not.toHaveBeenCalled();

        const pwa = vi.fn<UsageFetch>(async () => new Response(null, {status: 401}));
        await reportWebUiOpened(true, pwa, () => false);
        expect(pwa).toHaveBeenCalledOnce();
        expect(pwa.mock.calls[0]?.[0]).toBe('/api/me/usage/ui-opened');
    });

    test('anonymous opt out during backoff prevents the scheduled retry', async () => {
        let allowed = true;
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 503}));
        const delay = vi.fn<UsageRetryDelay>(async () => {
            allowed = false;
        });

        await reportWebUiOpened(false, fetcher, () => allowed, {delay});

        expect(fetcher).toHaveBeenCalledOnce();
        expect(delay).toHaveBeenCalledOnce();
    });

    test('hidden state cancels a scheduled retry and visible state starts a safe report', async () => {
        const harness = visibilityHarness();
        const delay = abortablePendingDelay();
        let requestCount = 0;
        const fetcher = vi.fn<UsageFetch>(async () => {
            requestCount += 1;
            return new Response(null, {status: requestCount === 1 ? 503 : 204});
        });

        const stop = startWebUsageReporting({
            installedPwa: false,
            fetcher,
            documentObject: harness.documentObject,
            delay,
        });
        await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());

        harness.emit('hidden');
        harness.emit('visible');

        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        stop();
    });

    test('stop cancels a scheduled retry and removes the listener', async () => {
        const harness = visibilityHarness();
        const delay = abortablePendingDelay();
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 503}));

        const stop = startWebUsageReporting({
            installedPwa: false,
            fetcher,
            documentObject: harness.documentObject,
            delay,
        });
        await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());

        stop();
        await Promise.resolve();
        await Promise.resolve();

        expect(fetcher).toHaveBeenCalledOnce();
        expect(harness.removeEventListener).toHaveBeenCalledWith(
            'visibilitychange',
            harness.listener(),
        );
    });

    test('disabled reporting installs no listener and sends no request', () => {
        const harness = visibilityHarness();
        const fetcher = vi.fn<UsageFetch>(async () => new Response(null, {status: 204}));
        const addEventListener = vi.spyOn(harness.documentObject, 'addEventListener');

        const stop = startWebUsageReporting({
            installedPwa: false,
            enabled: false,
            fetcher,
            documentObject: harness.documentObject,
        });
        stop();

        expect(addEventListener).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('does not overlap reports and reports again after restored visibility', async () => {
        const harness = visibilityHarness();
        let resolveFirst: (() => void) | undefined;
        let requestCount = 0;
        const fetcher = vi.fn<UsageFetch>(() => {
            requestCount += 1;
            if (requestCount > 1) return Promise.resolve(new Response(null, {status: 204}));
            return new Promise<Response>((resolve) => {
                resolveFirst = () => resolve(new Response(null, {status: 204}));
            });
        });

        const stop = startWebUsageReporting({
            installedPwa: false,
            fetcher,
            documentObject: harness.documentObject,
        });
        harness.emit('visible');
        expect(fetcher).toHaveBeenCalledOnce();

        resolveFirst?.();
        await Promise.resolve();
        await Promise.resolve();
        harness.emit('hidden');
        harness.emit('visible');

        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        stop();
    });
});
