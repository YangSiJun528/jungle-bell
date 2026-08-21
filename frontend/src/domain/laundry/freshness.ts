export interface LaundrySituationDataState {
    hasData: boolean;
    error: unknown;
    sourceFreshness?: string;
    expectedRefreshIntervalSeconds?: number;
    snapshotSavedAt: number | null;
    nowMs: number;
}

const DEFAULT_EXPECTED_REFRESH_INTERVAL_SECONDS = 300;
const REFRESH_GRACE_MULTIPLIER = 2;
const RELIABLE_SOURCE_FRESHNESS = new Set([
    'REFRESH_OBSERVED',
    'WITHIN_REFRESH_WINDOW',
    'UNVERIFIABLE_STABLE',
]);

export function laundrySituationDataIsReliable(state: LaundrySituationDataState): boolean {
    if (
        !state.hasData ||
        state.error ||
        !RELIABLE_SOURCE_FRESHNESS.has(state.sourceFreshness ?? '') ||
        typeof state.snapshotSavedAt !== 'number' ||
        !Number.isFinite(state.snapshotSavedAt)
    ) {
        return false;
    }

    const ageMs = state.nowMs - state.snapshotSavedAt;
    const expectedRefreshIntervalSeconds =
        state.expectedRefreshIntervalSeconds ?? DEFAULT_EXPECTED_REFRESH_INTERVAL_SECONDS;
    if (!Number.isFinite(expectedRefreshIntervalSeconds) || expectedRefreshIntervalSeconds <= 0) {
        return false;
    }
    return ageMs >= 0 && ageMs <= expectedRefreshIntervalSeconds * 1_000 * REFRESH_GRACE_MULTIPLIER;
}
