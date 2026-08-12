export const MIN_SIDEBAR_WIDTH = 192;
export const MAX_SIDEBAR_WIDTH = 320;
export const SIDEBAR_WIDTH_STEP = 8;
export const DEFAULT_SIDEBAR_WIDTH = 232;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'jungle-bell:sidebar-width:v1';

interface SidebarWidthStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export function normalizeSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
    const stepped = Math.round(value / SIDEBAR_WIDTH_STEP) * SIDEBAR_WIDTH_STEP;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stepped));
}

export function sidebarWidthFromKey(value: number, key: string): number | null {
    switch (key) {
        case 'ArrowLeft':
        case 'ArrowDown':
            return normalizeSidebarWidth(value - SIDEBAR_WIDTH_STEP);
        case 'ArrowRight':
        case 'ArrowUp':
            return normalizeSidebarWidth(value + SIDEBAR_WIDTH_STEP);
        case 'Home':
            return MIN_SIDEBAR_WIDTH;
        case 'End':
            return MAX_SIDEBAR_WIDTH;
        default:
            return null;
    }
}

export function sidebarWidthFromPointer(
    clientX: number,
    trackLeft: number,
    trackWidth: number,
): number | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(trackLeft) || !Number.isFinite(trackWidth) || trackWidth <= 0) {
        return null;
    }
    const ratio = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
    return normalizeSidebarWidth(MIN_SIDEBAR_WIDTH + ratio * (MAX_SIDEBAR_WIDTH - MIN_SIDEBAR_WIDTH));
}

export function readSidebarWidth(
    storage?: SidebarWidthStorage,
): number {
    try {
        const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
        if (!target) return DEFAULT_SIDEBAR_WIDTH;
        const value = target.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
        return value === null ? DEFAULT_SIDEBAR_WIDTH : normalizeSidebarWidth(Number(value));
    } catch {
        return DEFAULT_SIDEBAR_WIDTH;
    }
}

export function writeSidebarWidth(storage: SidebarWidthStorage, value: number): void {
    try {
        storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(normalizeSidebarWidth(value)));
    } catch {
        // The in-memory value remains authoritative when storage is unavailable.
    }
}
