import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    dashboardDdayLabel,
    dashboardDdayPeriod,
} from './home-overview';

const attendance = {
    attendanceDate: '2026-08-10',
    cohortId: 'jungle-1',
    cohortStatus: 'active',
    cohortStartDate: '2026-08-01',
    cohortEndDate: '2026-08-31',
    morningChecked: true,
    eveningChecked: false,
    collectedAt: '2026-08-10T08:00:00.000Z',
};

test('홈 D-Day는 출석 snapshot의 cohort 기간에서만 계산한다', () => {
    assert.deepEqual(dashboardDdayPeriod(attendance), {
        startDate: '2026-08-01',
        endDate: '2026-08-31',
    });
    assert.equal(dashboardDdayLabel(attendance, '2026-08-10'), '수료까지 D-21');
    assert.equal(dashboardDdayLabel({...attendance, cohortStatus: 'upcoming'}, '2026-07-28'), '시작까지 D-4');
    assert.equal(dashboardDdayLabel({...attendance, cohortStatus: 'ended'}, '2026-09-01'), '과정 종료');
    assert.equal(dashboardDdayPeriod({...attendance, cohortEndDate: '2026-02-30'}), null);
    assert.equal(dashboardDdayPeriod({...attendance, cohortStartDate: null}), null);
});
