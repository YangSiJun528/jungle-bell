import type {
    AccountAuthProvider,
    AccountSessionLease,
    DesktopHttpSessionBootstrap,
    NativeBridge,
} from '@/platform/contracts';
import {hasOwn} from '@/lib/object';

const DEFAULT_REFRESH_SKEW_MS = 60_000;
const MIN_SESSION_LIFETIME_MS = 30_000;
const MAX_SESSION_LIFETIME_MS = 10 * 60_000;

interface DesktopHttpSession {
    accessToken: string;
    expiresAtEpochMs: number;
}

export function createDesktopHttpSessionManager(options: {
    nativeBridge: Pick<NativeBridge, 'bootstrapDesktopHttpSession'>;
    now?: () => number;
    refreshSkewMs?: number;
}): AccountAuthProvider {
    const now = options.now ?? Date.now;
    const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    let current: DesktopHttpSession | null = null;
    let refreshPromise: Promise<DesktopHttpSession> | null = null;
    let generation = 0;

    const usable = (session: DesktopHttpSession | null): session is DesktopHttpSession =>
        session !== null && session.expiresAtEpochMs - now() > refreshSkewMs;

    const refresh = (): Promise<DesktopHttpSession> => {
        if (refreshPromise) return refreshPromise;
        const refreshGeneration = generation;
        const pending = options.nativeBridge.bootstrapDesktopHttpSession()
            .then((wire) => validateSession(wire, now()))
            .then((session) => {
                if (refreshGeneration !== generation) {
                    throw new Error('DESKTOP_HTTP_SESSION_INVALIDATED');
                }
                current = session;
                return session;
            })
            .finally(() => {
                if (refreshPromise === pending) refreshPromise = null;
            });
        refreshPromise = pending;
        return pending;
    };

    const session = (): Promise<DesktopHttpSession> => usable(current)
        ? Promise.resolve(current)
        : refresh();

    const assertCurrent = (lease: AccountSessionLease): void => {
        if (lease.generation !== generation) {
            throw new Error('DESKTOP_HTTP_SESSION_INVALIDATED');
        }
    };

    const sessionLease = async (): Promise<AccountSessionLease> => {
        const leaseGeneration = generation;
        const active = await session();
        const lease = {accessToken: active.accessToken, generation: leaseGeneration};
        assertCurrent(lease);
        return lease;
    };

    return {
        getSessionLease: sessionLease,
        async refreshAfterUnauthorized(rejectedLease) {
            assertCurrent(rejectedLease);
            if (current?.accessToken === rejectedLease.accessToken) current = null;
            const refreshedLease = await sessionLease();
            assertCurrent(rejectedLease);
            return refreshedLease;
        },
        assertCurrent,
        clear() {
            generation += 1;
            current = null;
            refreshPromise = null;
        },
    };
}

function validateSession(wire: DesktopHttpSessionBootstrap, nowEpochMs: number): DesktopHttpSession {
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) throw invalidResponse();
    const source = wire as unknown as Record<string, unknown>;
    if (Object.keys(source).length !== 2
        || !hasOwn(source, 'accessToken')
        || !hasOwn(source, 'expiresAt')
        || typeof source.accessToken !== 'string'
        || typeof source.expiresAt !== 'string'
        || !/^jbui_[0-9a-f]{64}$/u.test(source.accessToken)) {
        throw invalidResponse();
    }
    const expiresAtEpochMs = Date.parse(source.expiresAt);
    if (!Number.isFinite(expiresAtEpochMs)
        || new Date(expiresAtEpochMs).toISOString() !== source.expiresAt
        || expiresAtEpochMs <= nowEpochMs + MIN_SESSION_LIFETIME_MS
        || expiresAtEpochMs > nowEpochMs + MAX_SESSION_LIFETIME_MS) {
        throw invalidResponse();
    }
    return {accessToken: source.accessToken, expiresAtEpochMs};
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
