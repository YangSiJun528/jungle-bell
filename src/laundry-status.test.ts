import assert from 'node:assert/strict';
import test from 'node:test';
import {
    laundryAvailabilityState,
    summarizeLaundryAvailability,
} from './laundry-status.ts';

test('상세 projection이 완료이면 operationalStatus가 IDLE이어도 사용 가능으로 집계하지 않는다', () => {
    assert.equal(laundryAvailabilityState({
        operationalStatus: 'IDLE',
        projection: {status: 'CONFIRMED_COMPLETED'},
    }), 'unavailable');
});

test('상세 projection이 작동 중이면 operationalStatus가 IDLE이어도 사용 가능으로 집계하지 않는다', () => {
    assert.equal(laundryAvailabilityState({
        operationalStatus: 'IDLE',
        projection: {status: 'ESTIMATED_RUNNING'},
    }), 'unavailable');
});

test('상세 projection이 IDLE인 기기만 사용 가능으로 집계한다', () => {
    assert.equal(laundryAvailabilityState({
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE'},
    }), 'available');
});

test('예약과 오류는 상세 상태와 동일하게 사용 불가 또는 오류로 분류한다', () => {
    assert.equal(laundryAvailabilityState({
        operationalStatus: 'SCHEDULED',
        projection: {status: 'IDLE'},
    }), 'unavailable');
    assert.equal(laundryAvailabilityState({
        operationalStatus: 'IDLE',
        projection: {status: 'ERROR'},
    }), 'error');
});

test('projection이 없는 구형 응답은 operationalStatus로 판정한다', () => {
    assert.equal(laundryAvailabilityState({operationalStatus: 'IDLE'}), 'available');
    assert.equal(laundryAvailabilityState({operationalStatus: 'RUNNING'}), 'unavailable');
});

test('요약 가용 수와 분모는 상세 목록과 같은 이용 구역 범위를 사용한다', () => {
    const segments = [
        {zone: 'men' as const, state: 'available' as const},
        {zone: 'men' as const, state: 'available' as const},
        {zone: 'men' as const, state: 'available' as const},
        {zone: 'men' as const, state: 'unavailable' as const},
        {zone: 'men' as const, state: 'available' as const},
        {zone: 'common' as const, state: 'unavailable' as const},
        {zone: 'common' as const, state: 'available' as const},
        {zone: 'women' as const, state: 'available' as const},
        {zone: 'women' as const, state: 'available' as const},
    ];

    assert.deepEqual(summarizeLaundryAvailability(segments, 'all'), {available: 7, total: 9});
    assert.deepEqual(summarizeLaundryAvailability(segments, 'men'), {available: 5, total: 7});
    assert.deepEqual(summarizeLaundryAvailability(segments, 'women'), {available: 3, total: 4});
});
