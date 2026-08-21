import {describe, expect, it} from 'vitest';

import type {LaundryCapacitySnapshot} from '@/domain/laundry/capacity';

import {capacityCards} from './laundry-page-view';

const capacity: LaundryCapacitySnapshot = {
    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN',
    men: {
        access: 'men',
        washerAvailable: 3,
        projectedDryerSupply: 2,
        pendingDryerLoads: 1,
        dryerHeadroom: 1,
        startableLoads: 1,
        reliable: true,
    },
    women: {
        access: 'women',
        washerAvailable: 2,
        projectedDryerSupply: 1,
        pendingDryerLoads: 1,
        dryerHeadroom: 0,
        startableLoads: 0,
        reliable: false,
    },
};

describe('capacityCards', () => {
    it('서버가 신뢰 가능하다고 표시한 수치만 시작 가능 횟수로 노출한다', () => {
        expect(capacityCards(capacity, true)).toEqual([
            expect.objectContaining({
                access: 'men',
                count: 1,
                label: '남성 가능',
                status: 'available',
            }),
            expect.objectContaining({
                access: 'women',
                count: null,
                label: '여성 가능',
                status: 'checking',
            }),
        ]);
    });

    it('스냅샷 자체가 오래되었으면 모든 수치를 확인 중으로 처리한다', () => {
        expect(capacityCards(capacity, false).map(({count, status}) => ({count, status}))).toEqual([
            {count: null, status: 'checking'},
            {count: null, status: 'checking'},
        ]);
    });
});
