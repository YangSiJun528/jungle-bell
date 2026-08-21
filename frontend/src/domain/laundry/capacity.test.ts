import assert from 'node:assert/strict';

import {test} from 'vitest';

import {laundryCapacity} from './capacity';

const authoritativeCapacity = {
    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN' as const,
    men: {
        access: 'men' as const,
        washerAvailable: 4,
        projectedDryerSupply: 5,
        pendingDryerLoads: 2,
        dryerHeadroom: 3,
        startableLoads: 3,
        reliable: true,
    },
    women: {
        access: 'women' as const,
        washerAvailable: 2,
        projectedDryerSupply: 2,
        pendingDryerLoads: 1,
        dryerHeadroom: 1,
        startableLoads: 1,
        reliable: true,
    },
};

test('서버가 산출한 남녀별 횟수만 그대로 표시한다', () => {
    assert.deepEqual(laundryCapacity(authoritativeCapacity, true), {men: 3, women: 1});
});

test('서버 또는 로컬 snapshot을 신뢰할 수 없으면 횟수를 추측하지 않는다', () => {
    assert.deepEqual(laundryCapacity(authoritativeCapacity, false), {men: null, women: null});
    assert.deepEqual(laundryCapacity(null, true), {men: null, women: null});
    assert.deepEqual(
        laundryCapacity(
            {
                ...authoritativeCapacity,
                women: {...authoritativeCapacity.women, reliable: false, startableLoads: null},
            },
            true,
        ),
        {men: 3, women: null},
    );
});
