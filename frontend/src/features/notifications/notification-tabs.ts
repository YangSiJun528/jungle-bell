import type {DashboardNotification} from '@/api/dashboard-api';
import type {NotificationInboxItem} from '@/domain/notifications/inbox';

export function notificationRowsForTab(
    items: readonly (DashboardNotification | NotificationInboxItem)[],
    seenMobileIds: ReadonlySet<string>,
    tab: 'new' | 'history',
): Array<DashboardNotification | NotificationInboxItem> {
    const history = tab === 'history';
    return items.filter((item) => {
        const seen = 'createdAtEpochMs' in item ? seenMobileIds.has(item.id) : item.readAt !== null;
        return seen === history;
    });
}
