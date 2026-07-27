import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    dashboardDataIsStale,
    laundryDashboardRemaining,
    mealDashboardSummary,
    type LaundryDashboardCard,
    type MealDashboardCard,
} from './local-dashboard';

function laundry(overrides: Partial<LaundryDashboardCard> = {}): LaundryDashboardCard {
    return {
        machineId: 'tower6',
        machineLabel: '6번 기기',
        appliance: 'washer',
        sessionId: 'session-1',
        notifyBeforeMins: 5,
        status: 'running',
        estimatedFinishAt: '2026-07-27T09:05:00Z',
        updatedAt: Date.parse('2026-07-27T09:00:00Z'),
        sourceFreshness: 'WITHIN_REFRESH_WINDOW',
        ...overrides,
    };
}

test('선택한 세탁은 로컬 시계로 남은 시간을 계속 계산한다', () => {
    assert.equal(
        laundryDashboardRemaining(laundry(), Date.parse('2026-07-27T09:00:01Z')),
        '5분 남음',
    );
    assert.equal(
        laundryDashboardRemaining(laundry({status: 'completed'}), Date.parse('2026-07-27T09:06:00Z')),
        '완료',
    );
});

test('홈 카드는 종류별 허용 시간보다 오래되면 지연 상태를 표시한다', () => {
    assert.equal(dashboardDataIsStale(Date.parse('2026-07-27T09:00:00Z'), Date.parse('2026-07-27T09:02:01Z'), 120_000), true);
    assert.equal(dashboardDataIsStale(Date.parse('2026-07-27T09:00:00Z'), Date.parse('2026-07-27T09:01:00Z'), 120_000), false);
});

test('급식 홈 카드는 오늘 중식과 석식 게시 상태를 요약한다', () => {
    const card: MealDashboardCard = {
        targetWeekKey: '2026-07-27',
        title: '7월 4주차 식단',
        status: 'available',
        lunchTitle: '7월 27일 중식',
        dinnerTitle: null,
        updatedAt: Date.parse('2026-07-27T09:00:00Z'),
    };

    assert.equal(mealDashboardSummary(card), '중식 게시 · 석식 대기');
});
