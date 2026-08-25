import type {
    UsagePreferenceScope,
    UsagePreferenceSnapshot,
    UsagePrivacyAdapter,
} from '@/platform/contracts';

type UsageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface UsagePreferenceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const STORAGE_KEY = 'jungle-bell:anonymous-usage:v1';

function readLocalPreference(storage: UsagePreferenceStorage): boolean | null {
    try {
        const value = storage.getItem(STORAGE_KEY);
        if (value === 'disabled') return false;
    } catch {
        // Server cookies still enforce the preference when storage is unavailable.
    }
    return null;
}

function writeLocalPreference(storage: UsagePreferenceStorage, enabled: boolean): void {
    try {
        if (enabled) storage.removeItem(STORAGE_KEY);
        else storage.setItem(STORAGE_KEY, 'disabled');
    } catch {
        // The server preference remains authoritative when storage is unavailable.
    }
}

function browserStorage(): UsagePreferenceStorage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function parsePreference(value: unknown, scope: UsagePreferenceScope): UsagePreferenceSnapshot {
    if (
        !value ||
        typeof value !== 'object' ||
        !Object.prototype.hasOwnProperty.call(value, 'enabled') ||
        Object.keys(value).length !== 1
    ) {
        throw new Error('USAGE_PREFERENCE_RESPONSE_INVALID');
    }
    const enabled = Reflect.get(value, 'enabled');
    if (typeof enabled !== 'boolean') {
        throw new Error('USAGE_PREFERENCE_RESPONSE_INVALID');
    }
    return {enabled, scope};
}

async function readResponse(
    response: Response,
    scope: UsagePreferenceScope,
): Promise<UsagePreferenceSnapshot> {
    if (!response.ok) throw new Error(`USAGE_PREFERENCE_HTTP_${response.status}`);
    if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
        throw new Error('USAGE_PREFERENCE_RESPONSE_INVALID');
    }
    return parsePreference(await response.json(), scope);
}

function request(path: string, init?: RequestInit): [string, RequestInit] {
    return [
        path,
        {
            credentials: 'include',
            redirect: 'error',
            cache: 'no-store',
            ...init,
        },
    ];
}

export function createWebUsagePrivacyAdapter(options: {
    fetcher?: UsageFetch;
    storage?: UsagePreferenceStorage | null;
}): UsagePrivacyAdapter {
    const fetcher = options.fetcher ?? window.fetch.bind(window);
    const storage = options.storage === undefined ? browserStorage() : options.storage;

    const load = async (): Promise<UsagePreferenceSnapshot> => {
        const serverPreference = await readResponse(
            await fetcher(...request('/api/public/usage-preference')),
            'anonymous',
        );
        const localPreference = storage ? readLocalPreference(storage) : null;
        const enabled = serverPreference.enabled && localPreference !== false;
        if (storage && !serverPreference.enabled) writeLocalPreference(storage, false);
        return {enabled, scope: 'anonymous'};
    };

    return {
        available: true,
        get: load,
        async update(enabled) {
            if (!enabled && storage) writeLocalPreference(storage, false);
            const response = await fetcher(
                ...request('/api/public/usage-preference', {
                    method: 'PUT',
                    headers: {'content-type': 'application/json'},
                    body: JSON.stringify({enabled}),
                }),
            );
            const preference = await readResponse(response, 'anonymous');
            if (preference.enabled !== enabled) {
                throw new Error('USAGE_PREFERENCE_RESPONSE_INVALID');
            }
            if (enabled && storage) writeLocalPreference(storage, true);
            return preference;
        },
        allowsAnonymousReporting: () => !storage || readLocalPreference(storage) !== false,
    };
}
