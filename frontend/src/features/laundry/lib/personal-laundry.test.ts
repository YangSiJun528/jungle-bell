import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    hasDuplicateActiveWatch,
    laundryTargets,
    watchConditionLabel,
} from './personal-laundry';

const activeWatch = {
    id: `jbw_${'a'.repeat(64)}`,
    machineId: '워시타워_1',
    appliance: 'washer' as const,
    sessionId: 'session-1',
    notifyBeforeMinutes: 10,
    notifyWhenAvailable: true,
    status: 'active' as const,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
};

test('세탁 기기 target은 실행 중 session과 사용 가능 전환을 구분한다', () => {
    const targets = laundryTargets([{
        id: '워시타워_1',
        zone: 'men',
        washer: {
            appliance: 'washer', operationalStatus: 'RUNNING', sessionId: 'session-1',
            projection: {status: 'OBSERVED', remainingMinutes: 8},
        },
        dryer: {
            appliance: 'dryer', operationalStatus: 'IDLE', sessionId: 'old-session',
            projection: {status: 'IDLE', remainingMinutes: 0},
        },
    }]);

    assert.deepEqual(targets.map(({appliance, sessionId}) => ({appliance, sessionId})), [
        {appliance: 'washer', sessionId: 'session-1'},
        {appliance: 'dryer', sessionId: null},
    ]);
    assert.match(targets[0]?.label ?? '', /종료 10분 전/);
    assert.match(targets[1]?.label ?? '', /사용 가능 전환/);
    assert.equal(hasDuplicateActiveWatch([activeWatch], targets[0]!), true);
});

test('watch 문구는 알림 조건을 표시한다', () => {
    assert.equal(watchConditionLabel(activeWatch), '이 동작 종료 10분 전·완료·사용 가능 전환 알림');
});
