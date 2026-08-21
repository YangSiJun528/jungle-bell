import {describe, expect, test} from 'vitest';

import {
    readNotificationOnboardingDecision,
    writeNotificationOnboardingDecision,
} from './notification-onboarding-state';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
}

describe('notification onboarding state', () => {
    test('PC와 설치형 PWA의 결정을 독립적으로 보관한다', () => {
        const storage = memoryStorage();

        expect(readNotificationOnboardingDecision(storage, 'desktop')).toBeNull();
        expect(readNotificationOnboardingDecision(storage, 'pwa')).toBeNull();

        writeNotificationOnboardingDecision(storage, 'desktop', 'completed');
        expect(readNotificationOnboardingDecision(storage, 'desktop')).toBe('completed');
        expect(readNotificationOnboardingDecision(storage, 'pwa')).toBeNull();

        writeNotificationOnboardingDecision(storage, 'pwa', 'dismissed');
        expect(readNotificationOnboardingDecision(storage, 'pwa')).toBe('dismissed');
    });

    test('알 수 없는 값이나 사용할 수 없는 저장소는 미완료로 취급한다', () => {
        const values = memoryStorage();
        values.setItem('jungle-bell:notification-onboarding:desktop:v1', 'unexpected');
        expect(readNotificationOnboardingDecision(values, 'desktop')).toBeNull();

        const unavailable = {
            getItem: () => {
                throw new Error('STORAGE_UNAVAILABLE');
            },
            setItem: () => {
                throw new Error('STORAGE_UNAVAILABLE');
            },
        };
        expect(readNotificationOnboardingDecision(unavailable, 'desktop')).toBeNull();
        expect(() =>
            writeNotificationOnboardingDecision(unavailable, 'desktop', 'dismissed'),
        ).not.toThrow();
    });
});
