import assert from 'node:assert/strict';

import {test} from 'vitest';

import {laundrySituationDataIsReliable} from './freshness';

test('신뢰도는 데이터·오류·원본 상태·스냅샷 나이를 함께 검사한다', () => {
    const nowMs = 1_722_154_400_000;
    const base = {
        hasData: true,
        error: null,
        sourceFreshness: 'WITHIN_REFRESH_WINDOW',
        expectedRefreshIntervalSeconds: 300,
        snapshotSavedAt: nowMs - 30_000,
        nowMs,
    };

    assert.equal(laundrySituationDataIsReliable(base), true);
    assert.equal(laundrySituationDataIsReliable({...base, hasData: false}), false);
    assert.equal(laundrySituationDataIsReliable({...base, error: 'network'}), false);
    assert.equal(
        laundrySituationDataIsReliable({...base, sourceFreshness: 'COLLECTION_GAP'}),
        false,
    );
    assert.equal(laundrySituationDataIsReliable({...base, snapshotSavedAt: nowMs - 599_999}), true);
    assert.equal(
        laundrySituationDataIsReliable({...base, snapshotSavedAt: nowMs - 600_001}),
        false,
    );
    assert.equal(
        laundrySituationDataIsReliable({...base, expectedRefreshIntervalSeconds: 0}),
        false,
    );
    assert.equal(laundrySituationDataIsReliable({...base, snapshotSavedAt: nowMs + 60_001}), false);
});

test('실제 관측된 3.545초 시계 차이는 최근 정상 원본을 오래된 정보로 만들지 않는다', () => {
    assert.equal(
        laundrySituationDataIsReliable({
            hasData: true,
            error: null,
            sourceFreshness: 'WITHIN_REFRESH_WINDOW',
            expectedRefreshIntervalSeconds: 300,
            snapshotSavedAt: Date.parse('2026-09-19T20:35:30Z'),
            nowMs: Date.parse('2026-09-19T20:35:26.455Z'),
        }),
        true,
    );
});

test('시계 차이는 60초까지만 허용하며 원본 신뢰도와 10분 만료 경계를 유지한다', () => {
    const nowMs = Date.parse('2026-09-19T20:35:26.455Z');
    const base = {
        hasData: true,
        error: null,
        sourceFreshness: 'WITHIN_REFRESH_WINDOW',
        expectedRefreshIntervalSeconds: 300,
        snapshotSavedAt: nowMs,
        nowMs,
    };
    for (const [ageMs, reliable] of [
        [-60_001, false],
        [-60_000, true],
        [-3_545, true],
        [-1, true],
        [0, true],
        [120_000, true],
        [299_999, true],
        [300_000, true],
        [600_000, true],
        [600_001, false],
    ] as const) {
        assert.equal(
            laundrySituationDataIsReliable({...base, snapshotSavedAt: nowMs - ageMs}),
            reliable,
            `ageMs=${ageMs}`,
        );
    }
    for (const sourceFreshness of ['REFRESH_OVERDUE', 'COLLECTION_GAP']) {
        assert.equal(
            laundrySituationDataIsReliable({
                ...base,
                sourceFreshness,
                snapshotSavedAt: nowMs + 3_545,
            }),
            false,
        );
    }
});
