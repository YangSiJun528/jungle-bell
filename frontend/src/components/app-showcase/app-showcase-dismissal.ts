export const HOME_INSTALL_PROMOTION_DISMISSED_KEY = 'jungle-bell:home-install-promotion-dismissed';

export interface InstallPromotionStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export function appShowcaseDismissed(storage?: InstallPromotionStorage): boolean {
    if (!storage) return false;
    try {
        return storage.getItem(HOME_INSTALL_PROMOTION_DISMISSED_KEY) === 'dismissed';
    } catch {
        return false;
    }
}

export function dismissAppShowcase(storage?: InstallPromotionStorage): void {
    if (!storage) return;
    try {
        storage.setItem(HOME_INSTALL_PROMOTION_DISMISSED_KEY, 'dismissed');
    } catch {
        // Storage can be blocked in private browsing. The in-memory dismissal still works.
    }
}
