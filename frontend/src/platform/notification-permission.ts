export type AppNotificationPermission = NotificationPermission | 'unsupported';

export function notificationPermissionFromRuntime(
    notification: Pick<typeof Notification, 'permission'> | undefined,
): AppNotificationPermission {
    return notification?.permission ?? 'unsupported';
}
