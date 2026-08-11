import assert from 'node:assert/strict';
import {test} from 'vitest';
import {laundrySituationDataIsReliable} from './freshness';

test('신뢰도는 데이터·오류·원본 상태·스냅샷 나이를 함께 검사한다', () => {
    const nowMs = 1_722_154_400_000;
    const base = {
        hasData: true,
        error: null,
        sourceFreshness: 'WITHIN_REFRESH_WINDOW',
        snapshotSavedAt: nowMs - 30_000,
        nowMs,
    };

    assert.equal(laundrySituationDataIsReliable(base), true);
    assert.equal(laundrySituationDataIsReliable({...base, hasData: false}), false);
    assert.equal(laundrySituationDataIsReliable({...base, error: 'network'}), false);
    assert.equal(laundrySituationDataIsReliable({...base, sourceFreshness: 'COLLECTION_GAP'}), false);
    assert.equal(laundrySituationDataIsReliable({...base, snapshotSavedAt: nowMs - 120_001}), false);
    assert.equal(laundrySituationDataIsReliable({...base, snapshotSavedAt: nowMs + 1}), false);
});
