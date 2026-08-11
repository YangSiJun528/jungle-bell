export interface LaundrySituationDataState {
    hasData: boolean;
    error: unknown;
    sourceFreshness?: string;
    snapshotSavedAt: number | null;
    nowMs: number;
}

const MAX_SNAPSHOT_AGE_MS = 120_000;
const RELIABLE_SOURCE_FRESHNESS = new Set([
    'REFRESH_OBSERVED',
    'WITHIN_REFRESH_WINDOW',
    'UNVERIFIABLE_STABLE',
]);

export function laundrySituationDataIsReliable(state: LaundrySituationDataState): boolean {
    if (
        !state.hasData
        || state.error
        || !RELIABLE_SOURCE_FRESHNESS.has(state.sourceFreshness ?? '')
        || !Number.isFinite(state.snapshotSavedAt)
    ) {
        return false;
    }

    const ageMs = state.nowMs - (state.snapshotSavedAt as number);
    return ageMs >= 0 && ageMs <= MAX_SNAPSHOT_AGE_MS;
}
