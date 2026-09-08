import assert from 'node:assert/strict';

import {test} from 'vitest';

import {
    clearPendingMobilePairing,
    PENDING_MOBILE_PAIRING_KEY,
    readPendingMobilePairing,
    storePendingMobilePairing,
} from './pending-pairing';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        values,
        getItem(key: string) {
            return values.get(key) ?? null;
        },
        setItem(key: string, value: string) {
            values.set(key, value);
        },
        removeItem(key: string) {
            values.delete(key);
        },
    };
}

const pending = {
    pairingId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
    claimId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
    createdAtEpochMs: 1_785_727_000_000,
};

test('pending pairing은 식별자와 생성 시각만 영속 저장소에 보존한다', () => {
    const storage = memoryStorage();
    storePendingMobilePairing(storage, pending);

    const serialized = storage.values.get(PENDING_MOBILE_PAIRING_KEY) ?? '';
    assert.deepEqual(JSON.parse(serialized), pending);
    assert.doesNotMatch(serialized, /receipt|token|authorization|bearer/i);
    assert.deepEqual(
        readPendingMobilePairing(storage, pending.createdAtEpochMs + 599_999),
        pending,
    );

    clearPendingMobilePairing(storage);
    assert.equal(storage.values.has(PENDING_MOBILE_PAIRING_KEY), false);
});

test('새 브라우저 실행에서 같은 local storage를 읽어 승인 대기를 복구한다', () => {
    const persistentValues = new Map<string, string>();
    const firstRun = {
        getItem: (key: string) => persistentValues.get(key) ?? null,
        setItem: (key: string, value: string) => persistentValues.set(key, value),
        removeItem: (key: string) => persistentValues.delete(key),
    };
    storePendingMobilePairing(firstRun, pending);

    const restartedRun = {
        getItem: firstRun.getItem,
        setItem: firstRun.setItem,
        removeItem: firstRun.removeItem,
    };
    assert.deepEqual(
        readPendingMobilePairing(restartedRun, pending.createdAtEpochMs + 30_000),
        pending,
    );
});

test('pending pairing은 10분이 지나거나 필드가 위조되면 제거한다', () => {
    for (const value of [
        pending,
        {...pending, claimReceipt: `jbcr_${'a'.repeat(64)}`},
        {...pending, pairingId: '../pairing'},
        {...pending, createdAtEpochMs: pending.createdAtEpochMs + 10_000},
    ]) {
        const storage = memoryStorage();
        storage.setItem(PENDING_MOBILE_PAIRING_KEY, JSON.stringify(value));
        const now =
            value === pending ? pending.createdAtEpochMs + 600_000 : pending.createdAtEpochMs;
        assert.equal(readPendingMobilePairing(storage, now), null);
        assert.equal(storage.values.has(PENDING_MOBILE_PAIRING_KEY), false);
    }
});
