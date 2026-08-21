export type NotificationAction = 'openAttendance' | 'openLaundry' | 'openMeals';

export interface NotificationInboxItem {
    id: string;
    title: string;
    body: string;
    createdAt: number;
    readAt: number | null;
    action: NotificationAction | null;
}

export interface NotificationInboxSnapshot {
    revision: number;
    unreadCount: number;
    items: NotificationInboxItem[];
}

export function markNotificationInboxItemRead(
    snapshot: NotificationInboxSnapshot,
    id: string,
    readAt: number,
): NotificationInboxSnapshot {
    const index = snapshot.items.findIndex((item) => item.id === id);
    const item = snapshot.items[index];
    if (!item || item.readAt !== null) return snapshot;
    const items = snapshot.items.slice();
    items[index] = {...item, readAt};
    return {
        ...snapshot,
        unreadCount: Math.max(0, snapshot.unreadCount - 1),
        items,
    };
}

export function markAllNotificationInboxItemsRead(
    snapshot: NotificationInboxSnapshot,
    readAt: number,
): NotificationInboxSnapshot {
    if (snapshot.unreadCount === 0) return snapshot;
    return {
        ...snapshot,
        unreadCount: 0,
        items: snapshot.items.map((item) => (item.readAt === null ? {...item, readAt} : item)),
    };
}

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_NOTIFICATION_ITEMS = 100;

function isNonEmptyText(value: unknown, maxLength: number): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength &&
        !/\p{Cc}/u.test(value)
    );
}

function isTimestamp(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MAX_TIMESTAMP
    );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNotificationAction(value: unknown): value is NotificationAction {
    return value === 'openAttendance' || value === 'openLaundry' || value === 'openMeals';
}

export function normalizeNotificationInboxSnapshot(
    value: unknown,
): NotificationInboxSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<NotificationInboxSnapshot>;
    if (
        !hasExactKeys(candidate, ['revision', 'unreadCount', 'items']) ||
        !isNonNegativeSafeInteger(candidate.revision) ||
        !isNonNegativeSafeInteger(candidate.unreadCount) ||
        !Array.isArray(candidate.items) ||
        candidate.items.length > MAX_NOTIFICATION_ITEMS
    ) {
        return null;
    }

    const ids = new Set<string>();
    const items: NotificationInboxItem[] = [];
    for (const candidateItem of candidate.items) {
        if (!candidateItem || typeof candidateItem !== 'object') return null;
        const item = candidateItem as Partial<NotificationInboxItem>;
        if (
            !hasExactKeys(item, ['id', 'title', 'body', 'createdAt', 'readAt', 'action']) ||
            !isNonEmptyText(item.id, 32) ||
            !/^\d+$/.test(item.id) ||
            ids.has(item.id) ||
            !isNonEmptyText(item.title, 200) ||
            !isNonEmptyText(item.body, 1_000) ||
            !isTimestamp(item.createdAt) ||
            (item.readAt !== null && !isTimestamp(item.readAt)) ||
            (item.action !== null && !isNotificationAction(item.action))
        ) {
            return null;
        }

        ids.add(item.id);
        items.push({
            id: item.id,
            title: item.title,
            body: item.body,
            createdAt: item.createdAt,
            readAt: item.readAt,
            action: item.action,
        });
    }

    const unreadCount = items.filter((item) => item.readAt === null).length;
    if (candidate.unreadCount !== unreadCount) return null;

    return {
        revision: candidate.revision,
        unreadCount,
        items,
    };
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    const actual = Object.keys(value);
    return (
        actual.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
}
