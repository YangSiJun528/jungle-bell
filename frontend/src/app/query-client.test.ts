import {describe, expect, test, vi} from 'vitest';

import {createJungleBellQueryClient} from './query-client';

describe('query retry policy', () => {
    test.each([
        'AUTHENTICATION_REQUIRED',
        'SESSION_EXPIRED',
        'HTTP_401',
        'IDENTITY_RESET_REQUIRED',
        'DESKTOP_HTTP_SESSION_REQUIRED',
        'COMMAND_CONTEXT_DENIED',
        'ORIGIN_NOT_ALLOWED',
        'SESSION_SCOPE_DENIED',
        'SESSION_KIND_DENIED',
        'HTTP_403',
        'DESKTOP_HTTP_SESSION_INVALIDATED',
        'CONNECTED_SERVICE_AUTH_REQUIRED',
        'CONNECTED_SERVICE_IDENTITY_RESET_REQUIRED',
        'CONNECTED_SERVICE_RESPONSE_INVALID',
        'CONNECTED_SERVICE_REQUEST_REJECTED',
        'CONNECTED_SERVICE_CREDENTIAL_STORAGE_FAILED',
        'LMS_AUTH_REQUIRED',
    ])('does not retry terminal session error %s', async (code) => {
        const queryFn = vi.fn<() => Promise<never>>(async () => {
            throw new Error(code);
        });
        const client = createJungleBellQueryClient();

        await expect(client.fetchQuery({queryKey: ['terminal', code], queryFn})).rejects.toThrow(
            code,
        );
        expect(queryFn).toHaveBeenCalledTimes(1);
        client.clear();
    });

    test('retries one transient failure', async () => {
        const queryFn = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('HTTP_500'))
            .mockResolvedValueOnce('ok');
        const client = createJungleBellQueryClient();

        await expect(client.fetchQuery({queryKey: ['transient'], queryFn})).resolves.toBe('ok');
        expect(queryFn).toHaveBeenCalledTimes(2);
        client.clear();
    });
});
