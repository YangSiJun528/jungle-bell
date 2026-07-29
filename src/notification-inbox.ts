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

export const EMPTY_NOTIFICATION_INBOX: NotificationInboxSnapshot = {
    revision: 0,
    unreadCount: 0,
    items: [],
};

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_NOTIFICATION_ITEMS = 100;

function isNonEmptyText(value: unknown, maxLength: number): value is string {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= maxLength
        && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function isTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && (value as number) > 0
        && (value as number) <= MAX_TIMESTAMP;
}

function isNotificationAction(value: unknown): value is NotificationAction {
    return value === 'openAttendance'
        || value === 'openLaundry'
        || value === 'openMeals';
}

export function normalizeNotificationInboxSnapshot(value: unknown): NotificationInboxSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<NotificationInboxSnapshot>;
    if (!Number.isSafeInteger(candidate.revision)
        || (candidate.revision ?? -1) < 0
        || !Number.isSafeInteger(candidate.unreadCount)
        || (candidate.unreadCount ?? -1) < 0
        || !Array.isArray(candidate.items)
        || candidate.items.length > MAX_NOTIFICATION_ITEMS) {
        return null;
    }

    const ids = new Set<string>();
    const items: NotificationInboxItem[] = [];
    for (const value of candidate.items) {
        if (!value || typeof value !== 'object') return null;
        const item = value as Partial<NotificationInboxItem>;
        if (!isNonEmptyText(item.id, 32)
            || !/^\d+$/.test(item.id)
            || ids.has(item.id)
            || !isNonEmptyText(item.title, 200)
            || !isNonEmptyText(item.body, 1_000)
            || !isTimestamp(item.createdAt)
            || (item.readAt !== null && !isTimestamp(item.readAt))
            || (item.action !== null && !isNotificationAction(item.action))) {
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
        revision: candidate.revision as number,
        unreadCount,
        items,
    };
}

export function notificationActionLabel(action: NotificationAction | null): string {
    switch (action) {
        case 'openAttendance':
            return '출석 열기';
        case 'openLaundry':
            return '워시타워 열기';
        case 'openMeals':
            return '식단 열기';
        default:
            return '알림 읽기';
    }
}

export function notificationTriggerLabel(unreadCount: number): string {
    return unreadCount > 0
        ? `알림, 읽지 않은 알림 ${unreadCount}개`
        : '알림, 읽지 않은 알림 없음';
}

export function notificationItemLabel(item: NotificationInboxItem): string {
    const state = item.readAt === null ? '읽지 않음' : '읽음';
    return `${state}, ${item.title}, ${notificationActionLabel(item.action)}`;
}

interface CalendarDate {
    year: string;
    month: string;
    day: string;
}

function calendarDate(timestamp: number): CalendarDate | null {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    return year && month && day ? {year, month, day} : null;
}

export function notificationTimeLabel(createdAt: number, now = Date.now()): string {
    const created = calendarDate(createdAt);
    const current = calendarDate(now);
    if (!created || !current) return '';
    if (created.year === current.year
        && created.month === current.month
        && created.day === current.day) {
        return new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(createdAt));
    }
    return `${Number(created.month)}.${Number(created.day)}.`;
}
