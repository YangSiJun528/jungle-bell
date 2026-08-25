import {describe, expect, test, vi} from 'vitest';

import {createWebUsagePrivacyAdapter} from './usage-preference';

type UsageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function memoryStorage(initial?: string) {
    const values = new Map<string, string>();
    if (initial) values.set('jungle-bell:anonymous-usage:v1', initial);
    return {
        getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
        setItem: vi.fn<(key: string, value: string) => void>((key, value) => {
            values.set(key, value);
        }),
        removeItem: vi.fn<(key: string) => void>((key) => {
            values.delete(key);
        }),
    };
}

function jsonResponse(enabled: boolean, status = 200): Response {
    return new Response(JSON.stringify({enabled}), {
        status,
        headers: {'content-type': 'application/json'},
    });
}

describe('web usage preference', () => {
    test('ordinary web uses the public preference and keeps local opt out fail closed', async () => {
        const storage = memoryStorage('disabled');
        const fetcher = vi.fn<UsageFetch>(async () => jsonResponse(true));
        const adapter = createWebUsagePrivacyAdapter({
            fetcher,
            storage,
        });

        await expect(adapter.get()).resolves.toEqual({enabled: false, scope: 'anonymous'});
        expect(fetcher).toHaveBeenCalledWith(
            '/api/public/usage-preference',
            expect.objectContaining({credentials: 'include', cache: 'no-store'}),
        );
        expect(adapter.allowsAnonymousReporting()).toBe(false);
    });

    test('server opt out also closes the local reporting gate', async () => {
        const storage = memoryStorage();
        const fetcher = vi.fn<UsageFetch>(async () => jsonResponse(false));
        const adapter = createWebUsagePrivacyAdapter({
            fetcher,
            storage,
        });

        await expect(adapter.get()).resolves.toEqual({enabled: false, scope: 'anonymous'});
        expect(storage.setItem).toHaveBeenCalledWith('jungle-bell:anonymous-usage:v1', 'disabled');
        expect(adapter.allowsAnonymousReporting()).toBe(false);
    });

    test('anonymous opt out closes the local gate before a failed server write', async () => {
        const storage = memoryStorage();
        const fetcher = vi
            .fn<UsageFetch>()
            .mockResolvedValueOnce(jsonResponse(true))
            .mockRejectedValueOnce(new Error('offline'));
        const adapter = createWebUsagePrivacyAdapter({
            fetcher,
            storage,
        });
        await adapter.get();

        await expect(adapter.update(false)).rejects.toThrow('offline');
        expect(adapter.allowsAnonymousReporting()).toBe(false);
        expect(storage.setItem).toHaveBeenLastCalledWith(
            'jungle-bell:anonymous-usage:v1',
            'disabled',
        );
    });

    test('anonymous opt in clears the local sentinel only after the server accepts it', async () => {
        const storage = memoryStorage('disabled');
        const fetcher = vi
            .fn<UsageFetch>()
            .mockResolvedValueOnce(jsonResponse(false))
            .mockResolvedValueOnce(jsonResponse(true));
        const adapter = createWebUsagePrivacyAdapter({
            fetcher,
            storage,
        });
        await adapter.get();

        await expect(adapter.update(true)).resolves.toEqual({enabled: true, scope: 'anonymous'});
        expect(fetcher.mock.calls[1]).toEqual([
            '/api/public/usage-preference',
            expect.objectContaining({method: 'PUT', body: JSON.stringify({enabled: true})}),
        ]);
        expect(storage.removeItem).toHaveBeenCalledWith('jungle-bell:anonymous-usage:v1');
        expect(adapter.allowsAnonymousReporting()).toBe(true);
    });

    test('storage unavailability does not prevent the server preference from loading', async () => {
        const fetcher = vi.fn<UsageFetch>(async () => jsonResponse(true));
        const adapter = createWebUsagePrivacyAdapter({fetcher, storage: null});

        await expect(adapter.get()).resolves.toEqual({enabled: true, scope: 'anonymous'});
        expect(adapter.allowsAnonymousReporting()).toBe(true);
    });

    test('rejects responses outside the exact preference contract', async () => {
        const fetcher = vi.fn<UsageFetch>(
            async () =>
                new Response(JSON.stringify({enabled: true, extra: true}), {
                    status: 200,
                    headers: {'content-type': 'application/json'},
                }),
        );
        const adapter = createWebUsagePrivacyAdapter({fetcher, storage: memoryStorage()});

        await expect(adapter.get()).rejects.toThrow('USAGE_PREFERENCE_RESPONSE_INVALID');
    });
});
