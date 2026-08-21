import assert from 'node:assert/strict';

import {test} from 'vitest';

import {laundryWatchInputSchema} from './personal-contract';

const base = {
    machineId: '워시타워_1',
    appliance: 'washer',
    sessionId: 'session-1',
};

test('세탁 알림 입력은 세 가지 알림 시점과 분 값의 불변식을 검증한다', () => {
    for (const value of [
        {...base, notificationMode: 'before-completion', notifyBeforeMinutes: 10},
        {...base, notificationMode: 'estimated-completion', notifyBeforeMinutes: 0},
        {...base, notificationMode: 'confirmed-completion', notifyBeforeMinutes: 0},
    ]) {
        assert.equal(laundryWatchInputSchema.safeParse(value).success, true);
    }

    for (const value of [
        {...base, notificationMode: 'before-completion', notifyBeforeMinutes: 0},
        {...base, notificationMode: 'estimated-completion', notifyBeforeMinutes: 10},
        {...base, notificationMode: 'unknown', notifyBeforeMinutes: 0},
        {
            ...base,
            sessionId: null,
            notificationMode: 'confirmed-completion',
            notifyBeforeMinutes: 0,
        },
    ]) {
        assert.equal(laundryWatchInputSchema.safeParse(value).success, false);
    }
});
