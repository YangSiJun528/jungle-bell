import type {
    DesktopHttpSessionLease,
    DesktopHttpSessionManager,
} from './desktop-http-session';

export type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type CompanionApiPath =
    | `/api/mobile${'' | `/${string}` | `?${string}`}`
    | `/api/pairings${'' | `/${string}`}`
    | `/api/push/${string}`;
export type DesktopUiApiPath = `/api/desktop-ui/${string}`;

export interface HttpApiClient {
    publicResponse(path: `/api/public/${string}`, init?: RequestInit): Promise<Response>;
    companionResponse(path: CompanionApiPath, init?: RequestInit): Promise<Response>;
    desktopResponse(path: DesktopUiApiPath, init?: RequestInit): Promise<Response>;
}

export function createHttpApiClient(options: {
    fetcher: HttpFetch;
    publicBase: string;
    platformBase: string;
    desktopSession?: DesktopHttpSessionManager;
}): HttpApiClient {
    const fetchPublic = (path: `/api/public/${string}`, init: RequestInit = {}) => {
        assertApiPath(path, ['/api/public/']);
        return options.fetcher(
            apiUrl(options.publicBase, path),
            unauthenticatedRequestInit(init, 'omit', false),
        );
    };
    const fetchCompanion = (path: CompanionApiPath, init: RequestInit = {}) => {
        assertApiPath(path, ['/api/mobile', '/api/pairings', '/api/push/']);
        return options.fetcher(
            apiUrl(options.platformBase, path),
            unauthenticatedRequestInit(init, 'include', true),
        );
    };

    const fetchDesktop = async (
        path: DesktopUiApiPath,
        init: RequestInit = {},
    ): Promise<Response> => {
        assertApiPath(path, ['/api/desktop-ui/']);
        const session = options.desktopSession;
        if (!session) throw new Error('DESKTOP_HTTP_SESSION_REQUIRED');
        const firstLease = await session.getSessionLease();
        const firstResponse = await options.fetcher(
            apiUrl(options.platformBase, path),
            authenticatedRequestInit(init, firstLease.accessToken),
        );
        session.assertCurrent(firstLease);
        if (firstResponse.status !== 401) {
            return bufferedResponseWithinLease(firstResponse, session, firstLease);
        }
        const refreshedLease = await session.refreshAfterUnauthorized(firstLease);
        const refreshedResponse = await options.fetcher(
            apiUrl(options.platformBase, path),
            authenticatedRequestInit(init, refreshedLease.accessToken),
        );
        session.assertCurrent(refreshedLease);
        return bufferedResponseWithinLease(refreshedResponse, session, refreshedLease);
    };

    return {
        publicResponse: fetchPublic,
        companionResponse: fetchCompanion,
        desktopResponse: fetchDesktop,
    };
}

async function bufferedResponseWithinLease(
    response: Response,
    session: DesktopHttpSessionManager,
    lease: DesktopHttpSessionLease,
): Promise<Response> {
    try {
        // Cloning tees the stream: consuming the upstream branch buffers the return
        // branch while preserving status, statusText, headers, URL, type, null-body
        // semantics, and bodyUsed=false for callers.
        const buffered = response.clone();
        await response.arrayBuffer();
        session.assertCurrent(lease);
        return buffered;
    } catch (error) {
        session.assertCurrent(lease);
        throw error;
    }
}

function authenticatedRequestInit(init: RequestInit, accessToken: string): RequestInit {
    const headers = new Headers(init.headers);
    headers.delete('cookie');
    headers.set('authorization', `Bearer ${accessToken}`);
    return requestInit({...init, headers}, 'omit', true);
}

function unauthenticatedRequestInit(
    init: RequestInit,
    credentials: RequestCredentials,
    privateRequest: boolean,
): RequestInit {
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    return requestInit({...init, headers}, credentials, privateRequest);
}

function requestInit(
    init: RequestInit,
    credentials: RequestCredentials,
    privateRequest: boolean,
): RequestInit {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (init.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
    }
    return {
        ...init,
        credentials,
        redirect: 'error',
        ...(privateRequest ? {cache: 'no-store'} : {}),
        headers,
    };
}

function apiUrl(base: string, path: string): string {
    return base ? `${base}${path}` : path;
}

function assertApiPath(path: string, prefixes: readonly string[]): void {
    let parsed: URL;
    try {
        parsed = new URL(path, 'https://api.invalid');
    } catch {
        throw new Error('API_CLIENT_INVALID_ARGUMENT');
    }
    if (parsed.origin !== 'https://api.invalid'
        || parsed.hash
        || `${parsed.pathname}${parsed.search}` !== path
        || !prefixes.some((prefix) => path === prefix
            || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
            || path.startsWith(`${prefix}?`))) {
        throw new Error('API_CLIENT_INVALID_ARGUMENT');
    }
}
