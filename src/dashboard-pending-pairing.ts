export const PENDING_MOBILE_PAIRING_KEY = 'jungle-bell:pending-mobile-pairing';
export const PENDING_MOBILE_PAIRING_TTL_MS = 2 * 60_000;

const PAIRING_ID = /^jbp_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PendingMobilePairing {
    pairingId: string;
    claimId: string;
    createdAtEpochMs: number;
}

export interface PairingSessionStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export function storePendingMobilePairing(
    storage: PairingSessionStorage,
    pending: PendingMobilePairing,
): void {
    if (!validPending(pending, pending.createdAtEpochMs)) {
        throw new Error('PENDING_PAIRING_INVALID');
    }
    storage.setItem(PENDING_MOBILE_PAIRING_KEY, JSON.stringify({
        pairingId: pending.pairingId,
        claimId: pending.claimId,
        createdAtEpochMs: pending.createdAtEpochMs,
    }));
}

export function readPendingMobilePairing(
    storage: PairingSessionStorage,
    nowEpochMs: number,
): PendingMobilePairing | null {
    try {
        const serialized = storage.getItem(PENDING_MOBILE_PAIRING_KEY);
        if (serialized === null) return null;
        const value: unknown = JSON.parse(serialized);
        if (!validPending(value, nowEpochMs)) {
            clearPendingMobilePairing(storage);
            return null;
        }
        return value;
    } catch {
        clearPendingMobilePairing(storage);
        return null;
    }
}

export function clearPendingMobilePairing(storage: PairingSessionStorage): void {
    try {
        storage.removeItem(PENDING_MOBILE_PAIRING_KEY);
    } catch {
        // The HttpOnly pending-claim cookie remains the authority when storage is unavailable.
    }
}

function validPending(value: unknown, nowEpochMs: number): value is PendingMobilePairing {
    if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0
        || !value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length !== 3
        || !['pairingId', 'claimId', 'createdAtEpochMs'].every((key) => Object.hasOwn(source, key))) {
        return false;
    }
    const createdAtEpochMs = source.createdAtEpochMs;
    return typeof source.pairingId === 'string'
        && PAIRING_ID.test(source.pairingId)
        && typeof source.claimId === 'string'
        && PAIRING_ID.test(source.claimId)
        && typeof createdAtEpochMs === 'number'
        && Number.isSafeInteger(createdAtEpochMs)
        && createdAtEpochMs >= 0
        && createdAtEpochMs <= nowEpochMs
        && nowEpochMs - createdAtEpochMs < PENDING_MOBILE_PAIRING_TTL_MS;
}
