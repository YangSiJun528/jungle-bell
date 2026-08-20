export function pairingRemainingLabel(expiresAt: string, nowEpochMs: number): string {
    const expiresAtEpochMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtEpochMs)) return '만료됨';

    const remainingSeconds = Math.max(0, Math.ceil((expiresAtEpochMs - nowEpochMs) / 1_000));
    if (remainingSeconds === 0) return '만료됨';

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `남은 시간 ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
