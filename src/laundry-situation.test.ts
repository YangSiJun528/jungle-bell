import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    assessLaundryAccessSituation,
    laundrySituationDataIsReliable,
    type LaundrySituationMachine,
} from './laundry-situation.ts';
import type {LaundryStatusAppliance} from './laundry-status.ts';

const zones = [
    'men', 'men', 'men', 'men', 'men',
    'common', 'common',
    'women', 'women',
] as const;

function appliance(
    operationalStatus: string,
    projectionStatus?: string,
): LaundryStatusAppliance {
    return {
        operationalStatus,
        projection: projectionStatus ? {status: projectionStatus} : null,
    };
}

function machines(
    washerStatuses: readonly string[],
    dryerStatuses: readonly string[],
): LaundrySituationMachine[] {
    return zones.map((zone, index) => ({
        zone,
        washer: appliance(washerStatuses[index] ?? 'UNKNOWN'),
        dryer: appliance(dryerStatuses[index] ?? 'UNKNOWN'),
    }));
}

const FORECAST_NOW_MS = Date.parse('2026-07-28T14:27:00.000Z');

function timedAppliance(
    operationalStatus: string,
    remainingMinutes: number | null,
    projectionStatus = operationalStatus === 'IDLE' ? 'IDLE' : 'ESTIMATED_RUNNING',
): LaundryStatusAppliance {
    return {
        operationalStatus,
        estimatedFinishAt: remainingMinutes === null
            ? null
            : new Date(FORECAST_NOW_MS + remainingMinutes * 60_000).toISOString(),
        projection: {
            status: projectionStatus,
            ...(remainingMinutes === null ? {} : {remainingMinutes}),
        },
    };
}

test('모든 기기가 비어 있으면 남성·여성 구역 모두 여유 있음으로 추천한다', () => {
    const allIdle = Array(9).fill('IDLE');
    const observations = machines(allIdle, allIdle);

    assert.deepEqual(assessLaundryAccessSituation(observations, 'men', true), {
        access: 'men',
        total: 7,
        washerUsable: 7,
        dryerUsable: 7,
        activeWashers: 0,
        activeDryers: 0,
        pendingDryerLoads: 0,
        dryerHeadroom: 7,
        startableLoads: 7,
        washerUsableRatio: 1,
        dryerUsableRatio: 1,
        startableLoadRatio: 1,
        state: 'comfortable',
        recommendation: 'recommended',
    });
    assert.deepEqual(assessLaundryAccessSituation(observations, 'women', true), {
        access: 'women',
        total: 4,
        washerUsable: 4,
        dryerUsable: 4,
        activeWashers: 0,
        activeDryers: 0,
        pendingDryerLoads: 0,
        dryerHeadroom: 4,
        startableLoads: 4,
        washerUsableRatio: 1,
        dryerUsableRatio: 1,
        startableLoadRatio: 1,
        state: 'comfortable',
        recommendation: 'recommended',
    });
});

test('공용 6·7번 워시타워는 남성·여성 현황에 모두 포함한다', () => {
    const observations = machines(
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN'],
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN'],
    );

    const men = assessLaundryAccessSituation(observations, 'men', true);
    const women = assessLaundryAccessSituation(observations, 'women', true);

    assert.equal(men.total, 7);
    assert.equal(men.washerUsable, 2);
    assert.equal(women.total, 4);
    assert.equal(women.washerUsable, 2);
});

test('완료 상태는 추천용 빈자리로 계산한다', () => {
    const observations = machines(
        ['COMPLETED', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ['COMPLETED', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
    );
    observations[1] = {
        zone: 'men',
        washer: appliance('IDLE', 'CONFIRMED_COMPLETED'),
        dryer: appliance('IDLE', 'CONFIRMED_COMPLETED'),
    };

    const result = assessLaundryAccessSituation(observations, 'men', true);

    assert.equal(result.washerUsable, 2);
    assert.equal(result.dryerUsable, 2);
    assert.equal(result.pendingDryerLoads, 0);
});

test('데이터를 신뢰할 수 없으면 기기 수와 무관하게 확인 중으로 판단한다', () => {
    const allIdle = Array(9).fill('IDLE');
    const result = assessLaundryAccessSituation(machines(allIdle, allIdle), 'men', false);

    assert.equal(result.state, 'checking');
    assert.equal(result.recommendation, 'pending');
});

test('사용 가능한 세탁기가 없으면 자리 부족으로 추천하지 않는다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            Array(9).fill('UNKNOWN'),
            ['IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ),
        'men',
        true,
    );

    assert.equal(result.state, 'limited');
    assert.equal(result.recommendation, 'notRecommended');
});

test('사용 가능한 건조기가 작동 중 세탁기 수 이하면 건조기 부족으로 새 세탁을 말린다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            ['IDLE', 'RUNNING', 'COURSE_RUNNING', 'RUNNING', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
            ['IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ),
        'men',
        true,
    );

    assert.equal(result.pendingDryerLoads, 3);
    assert.equal(result.dryerUsable, 3);
    assert.equal(result.state, 'dryerBottleneck');
    assert.equal(result.recommendation, 'notRecommended');
});

test('건조기와 세탁기가 동시에 가동 중이어도 이후 건조 자리가 남으면 추천한다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            ['RUNNING', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE'],
            ['RUNNING', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE'],
        ),
        'men',
        true,
    );

    assert.equal(result.activeWashers, 1);
    assert.equal(result.activeDryers, 1);
    assert.equal(result.startableLoads, 5);
    assert.equal(result.state, 'comfortable');
    assert.equal(result.recommendation, 'recommended');
});

test('같은 현황에서 남성은 건조기 부족이고 여성은 한 자리를 시작할 수 있다', () => {
    const observations = machines(
        ['IDLE', 'IDLE', 'RUNNING', 'IDLE', 'RUNNING', 'IDLE', 'IDLE', 'RUNNING', 'IDLE'],
        ['ERROR', 'RUNNING', 'RUNNING', 'RUNNING', 'ERROR', 'RUNNING', 'RUNNING', 'IDLE', 'IDLE'],
    );
    const men = assessLaundryAccessSituation(observations, 'men', true);
    const women = assessLaundryAccessSituation(observations, 'women', true);

    assert.equal(men.dryerUsable, 0);
    assert.equal(men.state, 'dryerBottleneck');
    assert.equal(men.recommendation, 'notRecommended');

    assert.equal(women.total, 4);
    assert.equal(women.activeWashers, 1);
    assert.equal(women.activeDryers, 2);
    assert.equal(women.washerUsable, 3);
    assert.equal(women.dryerUsable, 2);
    assert.equal(women.pendingDryerLoads, 1);
    assert.equal(women.dryerHeadroom, 1);
    assert.equal(women.startableLoads, 1);
    assert.equal(women.state, 'available');
    assert.equal(women.recommendation, 'recommended');
});

test('화면 사례는 한 시간 안에 끝나는 건조기와 세탁기만 반영한다', () => {
    const observations: LaundrySituationMachine[] = zones.map((zone, index) => ({
        zone,
        washer: [
            timedAppliance('IDLE', null),
            timedAppliance('IDLE', null),
            timedAppliance('IDLE', null),
            timedAppliance('RUNNING', 159),
            timedAppliance('IDLE', null),
            timedAppliance('IDLE', null),
            timedAppliance('RUNNING', 0, 'AWAITING_COMPLETION_CONFIRMATION'),
            timedAppliance('IDLE', null),
            timedAppliance('IDLE', null),
        ][index],
        dryer: [
            timedAppliance('IDLE', null),
            {...timedAppliance('ERROR', null, 'ERROR'), errorCode: 'EMPTY_WATER_ALERT_ERROR'},
            timedAppliance('RUNNING', 96),
            timedAppliance('RUNNING', 148),
            timedAppliance('RUNNING', 62),
            timedAppliance('RUNNING', 61),
            timedAppliance('RUNNING', 4),
            timedAppliance('IDLE', null),
            timedAppliance('IDLE', null),
        ][index],
    }));

    const men = assessLaundryAccessSituation(observations, 'men', true, FORECAST_NOW_MS);
    const women = assessLaundryAccessSituation(observations, 'women', true, FORECAST_NOW_MS);

    assert.equal(men.washerUsable, 5);
    assert.equal(men.dryerUsable, 1);
    assert.equal(men.pendingDryerLoads, 1);
    assert.equal(men.dryerHeadroom, 1);
    assert.equal(men.startableLoads, 1);
    assert.equal(men.state, 'available');

    assert.equal(women.washerUsable, 3);
    assert.equal(women.dryerUsable, 2);
    assert.equal(women.pendingDryerLoads, 1);
    assert.equal(women.dryerHeadroom, 2);
    assert.equal(women.startableLoads, 2);
    assert.equal(women.state, 'comfortable');
});

test('종료 전망은 60분을 포함하고 61분부터 제외한다', () => {
    const result = assessLaundryAccessSituation([
        {
            zone: 'men',
            washer: timedAppliance('IDLE', null),
            dryer: timedAppliance('RUNNING', 60),
        },
        {
            zone: 'men',
            washer: timedAppliance('IDLE', null),
            dryer: timedAppliance('RUNNING', 61),
        },
    ], 'men', true, FORECAST_NOW_MS);

    assert.equal(result.dryerUsable, 0);
    assert.equal(result.dryerHeadroom, 1);
    assert.equal(result.startableLoads, 1);
});

test('종료 시각을 우선하고 유효하지 않으면 남은 시간을 사용한다', () => {
    const validLateDryer = {
        ...timedAppliance('RUNNING', 61),
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 30},
    };
    const fallbackDryer = {
        ...timedAppliance('RUNNING', 30),
        estimatedFinishAt: 'invalid',
    };
    const dryerResult = assessLaundryAccessSituation([
        {zone: 'men', washer: timedAppliance('IDLE', null), dryer: validLateDryer},
        {zone: 'men', washer: timedAppliance('IDLE', null), dryer: fallbackDryer},
    ], 'men', true, FORECAST_NOW_MS);

    const validLateWasher = {
        ...timedAppliance('RUNNING', 61),
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 30},
    };
    const fallbackWasher = {
        ...timedAppliance('RUNNING', 30),
        estimatedFinishAt: 'invalid',
    };
    const washerResult = assessLaundryAccessSituation([
        {zone: 'men', washer: validLateWasher, dryer: timedAppliance('IDLE', null)},
        {zone: 'men', washer: fallbackWasher, dryer: timedAppliance('IDLE', null)},
    ], 'men', true, FORECAST_NOW_MS);

    assert.equal(dryerResult.dryerHeadroom, 1);
    assert.equal(washerResult.pendingDryerLoads, 1);
});

test('예약 세탁기나 일시정지 건조기는 동시 가동 차단이 아니라 점유·건조 수요로만 계산한다', () => {
    const scheduledWasher = assessLaundryAccessSituation(
        machines(
            ['SCHEDULED', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE'],
            ['RUNNING', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE'],
        ),
        'men',
        true,
    );
    const pausedDryer = assessLaundryAccessSituation(
        machines(
            ['RUNNING', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE'],
            ['PAUSED', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE'],
        ),
        'men',
        true,
    );

    assert.equal(scheduledWasher.activeWashers, 0);
    assert.equal(scheduledWasher.activeDryers, 1);
    assert.equal(scheduledWasher.recommendation, 'recommended');
    assert.equal(pausedDryer.activeWashers, 1);
    assert.equal(pausedDryer.activeDryers, 0);
    assert.equal(pausedDryer.recommendation, 'recommended');
});

test('일시정지·예약·완료 확인 중 세탁물을 보수적인 건조기 수요로 계산한다', () => {
    const observations = machines(
        ['IDLE', 'PAUSED', 'SCHEDULED', 'COMPLETED', 'IDLE', 'IDLE', 'UNKNOWN'],
        ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
    );
    observations[4] = {
        zone: 'men',
        washer: appliance('IDLE', 'CONFIRMED_COMPLETED'),
        dryer: appliance('UNKNOWN'),
    };
    observations[5] = {
        zone: 'common',
        washer: appliance('IDLE', 'AWAITING_COMPLETION_CONFIRMATION'),
        dryer: appliance('UNKNOWN'),
    };

    const result = assessLaundryAccessSituation(observations, 'men', true);

    assert.equal(result.pendingDryerLoads, 3);
    assert.equal(result.dryerHeadroom, 1);
    assert.equal(result.startableLoads, 1);
    assert.equal(result.state, 'available');
    assert.equal(result.recommendation, 'recommended');
});

test('건조 수요를 빼고 한 자리만 남아도 이용 가능으로 판단한다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'RUNNING', 'RUNNING', 'RUNNING'],
            ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ),
        'men',
        true,
    );

    assert.equal(result.pendingDryerLoads, 3);
    assert.equal(result.dryerHeadroom, 1);
    assert.equal(result.startableLoads, 1);
    assert.equal(result.state, 'available');
    assert.equal(result.recommendation, 'recommended');
});

test('오류 또는 비유휴 projection이 남은 IDLE 기기는 추천용 빈자리로 계산하지 않는다', () => {
    const observations = machines(
        Array(9).fill('UNKNOWN'),
        Array(9).fill('UNKNOWN'),
    );
    observations[0] = {
        zone: 'men',
        washer: {...appliance('IDLE'), errorCode: 'ERROR'},
        dryer: appliance('IDLE', 'ERROR'),
    };
    observations[1] = {
        zone: 'men',
        washer: appliance('IDLE', 'AWAITING_COMPLETION_CONFIRMATION'),
        dryer: appliance('IDLE', 'PAUSED'),
    };

    const result = assessLaundryAccessSituation(observations, 'men', true);

    assert.equal(result.washerUsable, 0);
    assert.equal(result.dryerUsable, 0);
});

test('시작 가능한 기기가 여러 대면 여유 있음으로 추천한다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN'],
            ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN'],
        ),
        'men',
        true,
    );

    assert.equal(result.state, 'comfortable');
    assert.equal(result.recommendation, 'recommended');
});

test('시작 가능 자리가 두 자리 이상이면 여유 있음으로 추천한다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
            ['IDLE', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ),
        'men',
        true,
    );

    assert.equal(result.state, 'comfortable');
    assert.equal(result.recommendation, 'recommended');
});

test('실제 시작 가능 자리가 한 자리면 이용 가능으로 판단한다', () => {
    const result = assessLaundryAccessSituation(
        machines(
            ['IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
            ['IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ),
        'men',
        true,
    );

    assert.equal(result.state, 'available');
    assert.equal(result.recommendation, 'recommended');
});

test('규모와 관계없이 두 자리부터 여유 있고 한 자리도 이용 가능하다', () => {
    const threeOfFour = machines(
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN'],
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'IDLE', 'IDLE', 'UNKNOWN'],
    );
    const twoOfFour = machines(
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN'],
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'IDLE', 'UNKNOWN', 'UNKNOWN'],
    );
    const oneOfFour = machines(
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
        ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'IDLE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
    );

    assert.equal(assessLaundryAccessSituation(threeOfFour, 'women', true).state, 'comfortable');
    assert.equal(assessLaundryAccessSituation(twoOfFour, 'women', true).state, 'comfortable');
    assert.equal(assessLaundryAccessSituation(oneOfFour, 'women', true).state, 'available');
});

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
});
