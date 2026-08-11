import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    campusDataHealthReducer,
    initialCampusDataHealth,
} from './campus-data-health';

test('백그라운드 갱신 실패는 기존 데이터와 별도의 종류별 오류로 보존한다', () => {
    const failed = campusDataHealthReducer(initialCampusDataHealth, {
        type: 'failed',
        kind: 'laundry',
        message: 'network unavailable',
        reportedAt: 123,
    });

    assert.deepEqual(failed, {
        laundry: {message: 'network unavailable', reportedAt: 123},
        meals: null,
    });
});

test('새 snapshot을 받은 종류의 오류만 해제한다', () => {
    const withBothErrors = campusDataHealthReducer(
        campusDataHealthReducer(initialCampusDataHealth, {
            type: 'failed',
            kind: 'laundry',
            message: 'laundry failed',
            reportedAt: 1,
        }),
        {
            type: 'failed',
            kind: 'meals',
            message: 'meals failed',
            reportedAt: 2,
        },
    );

    assert.deepEqual(campusDataHealthReducer(withBothErrors, {
        type: 'succeeded',
        kind: 'laundry',
    }), {
        laundry: null,
        meals: {message: 'meals failed', reportedAt: 2},
    });
});
