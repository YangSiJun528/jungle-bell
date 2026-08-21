import assert from 'node:assert/strict';

import {test} from 'vitest';

import {
    buildLaundryWatchInput,
    hasDuplicateActiveWatch,
    laundryTargets,
    watchConditionLabel,
} from './personal-laundry';

const activeWatch = {
    id: `jbw_${'a'.repeat(64)}`,
    machineId: '워시타워_1',
    appliance: 'washer' as const,
    sessionId: 'session-1',
    notificationMode: 'before-completion' as const,
    notifyBeforeMinutes: 10,
    status: 'active' as const,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
};

test('세탁 기기 target은 현재 실행 중인 session을 식별한다', () => {
    const targets = laundryTargets([
        {
            id: '워시타워_1',
            zone: 'men',
            washer: {
                appliance: 'washer',
                operationalStatus: 'RUNNING',
                sessionId: 'session-1',
                projection: {status: 'OBSERVED', remainingMinutes: 8},
            },
            dryer: {
                appliance: 'dryer',
                operationalStatus: 'IDLE',
                sessionId: 'old-session',
                projection: {status: 'IDLE', remainingMinutes: 0},
            },
        },
    ]);

    assert.deepEqual(
        targets.map(({appliance, sessionId}) => ({appliance, sessionId})),
        [
            {appliance: 'washer', sessionId: 'session-1'},
            {appliance: 'dryer', sessionId: null},
        ],
    );
    assert.match(targets[0]?.label ?? '', /8분 남음/);
    assert.match(targets[1]?.label ?? '', /건조기/);
    assert.equal(hasDuplicateActiveWatch([activeWatch], targets[0]!), true);
});

test('세 알림 모드는 서버 입력으로 정확히 변환된다', () => {
    const target = laundryTargets([
        {
            id: '워시타워_1',
            washer: {
                appliance: 'washer',
                operationalStatus: 'RUNNING',
                sessionId: 'session-1',
                projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 8},
            },
            dryer: null,
        },
    ])[0]!;

    assert.deepEqual(buildLaundryWatchInput(target, 'before-completion', 15), {
        machineId: '워시타워_1',
        appliance: 'washer',
        sessionId: 'session-1',
        notificationMode: 'before-completion',
        notifyBeforeMinutes: 15,
    });
    assert.deepEqual(buildLaundryWatchInput(target, 'estimated-completion', 15), {
        machineId: '워시타워_1',
        appliance: 'washer',
        sessionId: 'session-1',
        notificationMode: 'estimated-completion',
        notifyBeforeMinutes: 0,
    });
    assert.deepEqual(buildLaundryWatchInput(target, 'confirmed-completion', 15), {
        machineId: '워시타워_1',
        appliance: 'washer',
        sessionId: 'session-1',
        notificationMode: 'confirmed-completion',
        notifyBeforeMinutes: 0,
    });
});

test('watch 문구는 선택한 알림 시점 하나만 표시한다', () => {
    assert.equal(watchConditionLabel(activeWatch), '10분 남았을 때 알림');
    assert.equal(
        watchConditionLabel({
            ...activeWatch,
            notificationMode: 'estimated-completion',
            notifyBeforeMinutes: 0,
        }),
        '완료 예상 시점 알림',
    );
    assert.equal(
        watchConditionLabel({
            ...activeWatch,
            notificationMode: 'confirmed-completion',
            notifyBeforeMinutes: 0,
        }),
        '완료 확정 시점 알림',
    );
});
