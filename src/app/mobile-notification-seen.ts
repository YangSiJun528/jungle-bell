const SEEN_NOTIFICATIONS_KEY = 'jungle-bell:seen-mobile-notifications:v1';
const LEGACY_SEEN_NOTIFICATIONS_KEY = 'jungle-bell:seen-mobile-notifications';
const MAX_SEEN_NOTIFICATION_IDS = 100;

interface NotificationSeenStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function parseSeenIds(value: string | null): Set<string> {
    if (value === null) return new Set();
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed
        .filter((id): id is string => typeof id === 'string')
        .slice(0, MAX_SEEN_NOTIFICATION_IDS));
}

export function readSeenMobileNotificationIds(
    storage: NotificationSeenStorage = window.localStorage,
): Set<string> {
    try {
        const current = storage.getItem(SEEN_NOTIFICATIONS_KEY);
        return parseSeenIds(current ?? storage.getItem(LEGACY_SEEN_NOTIFICATIONS_KEY));
    } catch {
        return new Set();
    }
}

export function writeSeenMobileNotificationIds(
    storage: NotificationSeenStorage,
    ids: ReadonlySet<string>,
): void {
    try {
        storage.setItem(
            SEEN_NOTIFICATIONS_KEY,
            JSON.stringify([...ids].slice(0, MAX_SEEN_NOTIFICATION_IDS)),
        );
        storage.removeItem(LEGACY_SEEN_NOTIFICATIONS_KEY);
    } catch {
        // The in-memory state remains authoritative when storage is unavailable.
    }
}

export function mergeSeenMobileNotificationIds(
    current: Set<string>,
    incoming: readonly string[],
): Set<string> {
    if (incoming.every((id) => current.has(id))) return current;
    return new Set([...incoming, ...current].slice(0, MAX_SEEN_NOTIFICATION_IDS));
}
