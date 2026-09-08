import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import type {MealPreferences} from '@/api/dashboard-api';

import {
    MEAL_PREFERENCES_DRAFT_KEY,
    preserveMealPreferencesDraft,
    readMealPreferencesDraft,
} from './meal-preferences-draft';

const editorSource = readFileSync(
    new URL('./meal-preferences-section.tsx', import.meta.url),
    'utf8',
);
const preferences: MealPreferences = {
    enabled: true,
    lunch: true,
    dinner: false,
    updatedAtEpochMs: 7,
};

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
}

describe('meal preferences PWA draft', () => {
    it('실제 급식 설정 producer가 reload preserver를 등록한다', () => {
        expect(editorSource).toContain('usePwaReloadPreserver(() =>');
        expect(editorSource).toContain('preserveMealPreferencesDraft(preferences, draft)');
    });

    it('저장 전 draft를 session storage에 보존하고 같은 서버 기준에서 복원한다', () => {
        const storage = memoryStorage();
        const draft = {enabled: true, lunch: false, dinner: true};

        expect(preserveMealPreferencesDraft(preferences, draft, storage)).toBe(true);
        expect(storage.getItem(MEAL_PREFERENCES_DRAFT_KEY)).not.toBeNull();
        expect(readMealPreferencesDraft(preferences, storage)).toEqual(draft);
    });

    it('서버 기준이 달라진 stale draft는 복원하지 않는다', () => {
        const storage = memoryStorage();
        preserveMealPreferencesDraft(
            preferences,
            {enabled: false, lunch: false, dinner: false},
            storage,
        );

        expect(readMealPreferencesDraft({...preferences, updatedAtEpochMs: 8}, storage)).toEqual({
            enabled: true,
            lunch: true,
            dinner: false,
        });
        expect(storage.getItem(MEAL_PREFERENCES_DRAFT_KEY)).toBeNull();
    });

    it('session storage 기록 실패 시 안전 reload를 거부한다', () => {
        const storage = {
            getItem: () => null,
            removeItem: () => undefined,
            setItem: () => {
                throw new Error('blocked');
            },
        };

        expect(
            preserveMealPreferencesDraft(
                preferences,
                {enabled: false, lunch: false, dinner: false},
                storage,
            ),
        ).toBe(false);
    });
});
