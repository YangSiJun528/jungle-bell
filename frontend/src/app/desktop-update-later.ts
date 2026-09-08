import {isRecord} from '@/lib/object';

const OPTIONAL_UPDATE_LATER_KEY = 'jungle-bell:desktop-update-later:v1';

type UpdateDeferralStorage = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStorageOrNull(): UpdateDeferralStorage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

export function isOptionalDesktopUpdateDeferred(
    version: string,
    storage: UpdateDeferralStorage | null = sessionStorageOrNull(),
): boolean {
    if (!storage) return false;
    try {
        const raw = storage.getItem(OPTIONAL_UPDATE_LATER_KEY);
        if (!raw) return false;
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value)) return false;
        return (
            Object.keys(value).length === 2 &&
            value.schemaVersion === 1 &&
            value.version === version
        );
    } catch {
        return false;
    }
}

export function deferOptionalDesktopUpdate(
    version: string,
    storage: UpdateDeferralStorage | null = sessionStorageOrNull(),
): void {
    if (!storage) return;
    try {
        storage.setItem(OPTIONAL_UPDATE_LATER_KEY, JSON.stringify({schemaVersion: 1, version}));
    } catch {
        // 저장소가 막혀 있으면 안내를 숨기지 않는 안전한 기본값을 유지한다.
    }
}
