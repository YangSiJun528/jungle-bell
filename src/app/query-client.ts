import {QueryClient} from '@tanstack/react-query';

export function createJungleBellQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: (failureCount, error) => failureCount < 1 && !authenticationFailure(error),
                refetchOnWindowFocus: true,
                refetchOnReconnect: true,
            },
            mutations: {retry: false},
        },
    });
}

function authenticationFailure(error: unknown): boolean {
    return error instanceof Error && [
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
    ].includes(error.message);
}
