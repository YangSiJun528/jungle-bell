export type NotificationOnboardingSurface = 'desktop' | 'pwa';
export type NotificationOnboardingDecision = 'completed' | 'dismissed';

interface NotificationOnboardingStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const NOTIFICATION_ONBOARDING_KEYS: Record<NotificationOnboardingSurface, string> = {
    desktop: 'jungle-bell:notification-onboarding:desktop:v1',
    pwa: 'jungle-bell:notification-onboarding:pwa:v1',
};

export function readNotificationOnboardingDecision(
    storage: Pick<NotificationOnboardingStorage, 'getItem'>,
    surface: NotificationOnboardingSurface,
): NotificationOnboardingDecision | null {
    try {
        const value = storage.getItem(NOTIFICATION_ONBOARDING_KEYS[surface]);
        return value === 'completed' || value === 'dismissed' ? value : null;
    } catch {
        return null;
    }
}

export function writeNotificationOnboardingDecision(
    storage: Pick<NotificationOnboardingStorage, 'setItem'>,
    surface: NotificationOnboardingSurface,
    decision: NotificationOnboardingDecision,
): void {
    try {
        storage.setItem(NOTIFICATION_ONBOARDING_KEYS[surface], decision);
    } catch {
        // The current session still hides the optional onboarding when storage is unavailable.
    }
}
