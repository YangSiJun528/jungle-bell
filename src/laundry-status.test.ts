import assert from 'node:assert/strict';
import test from 'node:test';
import {
    laundryAvailabilityState,
    laundryOperationLabel,
    laundryOverviewText,
    laundryRemainingText,
    laundryStartAt,
    summarizeLaundryAvailability,
} from './laundry-status.ts';

test('워시타워 요약은 사용 중인 기기의 잔여 시간을 HH:MM으로 표시한다', () => {
    assert.equal(laundryOverviewText({
        operationalStatus: 'RUNNING',
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 5},
    }), '00:05');
    assert.equal(laundryOverviewText({
        operationalStatus: 'RUNNING',
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 65},
    }), '01:05');
});

test('워시타워 요약은 오류와 정보 없음만 짧게 표시한다', () => {
    assert.equal(laundryOverviewText({
        operationalStatus: 'ERROR',
        projection: {status: 'ERROR', remainingMinutes: 20},
    }), 'ERROR');
    assert.equal(laundryOverviewText(null), '--:--');
});

test('워시타워 요약은 사용 가능한 기기에 텍스트를 표시하지 않는다', () => {
    assert.equal(laundryOverviewText({
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    }), '');
});

test('상세 화면은 대기 대신 사용 가능을 표시한다', () => {
    assert.equal(laundryRemainingText({
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    }), '사용 가능');
});

test('상세 화면은 수집기가 기록한 시작 시각만 사용한다', () => {
    assert.equal(laundryStartAt({
        operationalStatus: 'RUNNING',
        startedAt: '2026-07-20T05:50:02.020Z',
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 76},
    }), '2026-07-20T05:50:02.020Z');
    assert.equal(laundryStartAt({estimatedFinishAt: '2026-07-20T07:26:02.020Z'}), '1970-01-01T00:00:00.000Z');
});

test('세부 작동 상태를 우선하고 일반 RUNNING은 기기 종류에 맞게 표시한다', () => {
    assert.equal(laundryOperationLabel({appliance: 'washer', state: {code: 'RINSING'}}), '헹굼 중');
    assert.equal(laundryOperationLabel({appliance: 'washer', state: {code: 'SPINNING'}}), '탈수 중');
    assert.equal(laundryOperationLabel({appliance: 'washer', state: {code: 'RUNNING'}}), '세탁 중');
    assert.equal(laundryOperationLabel({appliance: 'dryer', state: {code: 'RUNNING'}}), '건조 중');
});

test('상세 projection이 완료이면 사용 가능 결과에 포함한다', () => {
    assert.equal(laundryAvailabilityState({
        operationalStatus: 'COMPLETED',
        projection: {status: 'CONFIRMED_COMPLETED'},
    }), 'available');
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
    assert.equal(laundryAvailabilityState({operationalStatus: 'COMPLETED'}), 'available');
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
