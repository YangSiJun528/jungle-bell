import type {MealPreferences, MealPreferencesInput} from '@/api/dashboard-api';
import {isRecord} from '@/lib/object';

export const MEAL_PREFERENCES_DRAFT_KEY = 'jungle-bell:pwa-draft:meal-preferences:v1';

export interface MealPreferencesDraftStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): unknown;
}

interface StoredMealPreferencesDraft {
    readonly version: 1;
    readonly baseline: MealPreferences;
    readonly draft: MealPreferencesInput;
}

function preferencesInput(preferences: MealPreferences): MealPreferencesInput {
    return {
        enabled: preferences.enabled,
        lunch: preferences.lunch,
        dinner: preferences.dinner,
    };
}

function isPreferencesInput(value: unknown): value is MealPreferencesInput {
    return (
        isRecord(value) &&
        Object.keys(value).length === 3 &&
        typeof value.enabled === 'boolean' &&
        typeof value.lunch === 'boolean' &&
        typeof value.dinner === 'boolean'
    );
}

function isPreferences(value: unknown): value is MealPreferences {
    return (
        isRecord(value) &&
        Object.keys(value).length === 4 &&
        isPreferencesInput({
            enabled: value.enabled,
            lunch: value.lunch,
            dinner: value.dinner,
        }) &&
        typeof value.updatedAtEpochMs === 'number' &&
        Number.isSafeInteger(value.updatedAtEpochMs)
    );
}

function isStoredDraft(value: unknown): value is StoredMealPreferencesDraft {
    return (
        isRecord(value) &&
        Object.keys(value).length === 3 &&
        value.version === 1 &&
        isPreferences(value.baseline) &&
        isPreferencesInput(value.draft)
    );
}

function sameInput(left: MealPreferencesInput, right: MealPreferencesInput): boolean {
    return (
        left.enabled === right.enabled && left.lunch === right.lunch && left.dinner === right.dinner
    );
}

function sameBaseline(left: MealPreferences, right: MealPreferences): boolean {
    return left.updatedAtEpochMs === right.updatedAtEpochMs && sameInput(left, right);
}

function browserSessionStorage(): MealPreferencesDraftStorage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

function discardDraft(storage: MealPreferencesDraftStorage): void {
    try {
        storage.removeItem(MEAL_PREFERENCES_DRAFT_KEY);
    } catch {
        // A blocked storage backend is handled by the caller's safe fallback.
    }
}

export function readMealPreferencesDraft(
    preferences: MealPreferences,
    storage: MealPreferencesDraftStorage | null = browserSessionStorage(),
): MealPreferencesInput {
    const fallback = preferencesInput(preferences);
    if (!storage) return fallback;
    try {
        const raw = storage.getItem(MEAL_PREFERENCES_DRAFT_KEY);
        if (!raw) return fallback;
        const stored: unknown = JSON.parse(raw);
        if (isStoredDraft(stored) && sameBaseline(stored.baseline, preferences)) {
            return {...stored.draft};
        }
    } catch {
        discardDraft(storage);
        return fallback;
    }
    discardDraft(storage);
    return fallback;
}

export function preserveMealPreferencesDraft(
    preferences: MealPreferences,
    draft: MealPreferencesInput,
    storage: MealPreferencesDraftStorage | null = browserSessionStorage(),
): boolean {
    if (!storage) return false;
    try {
        if (sameInput(preferences, draft)) {
            storage.removeItem(MEAL_PREFERENCES_DRAFT_KEY);
        } else {
            const stored: StoredMealPreferencesDraft = {
                version: 1,
                baseline: {...preferences},
                draft: {...draft},
            };
            storage.setItem(MEAL_PREFERENCES_DRAFT_KEY, JSON.stringify(stored));
        }
        return true;
    } catch {
        return false;
    }
}

export function clearMealPreferencesDraft(
    storage: MealPreferencesDraftStorage | null = browserSessionStorage(),
): void {
    if (storage) discardDraft(storage);
}
