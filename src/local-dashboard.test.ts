import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    dashboardDataIsStale,
    laundryDashboardRemaining,
    type LaundryDashboardCard,
    type MealAlertCard,
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

test('급식 홈 알림은 게시 이벤트별 메뉴 미리보기와 이동 날짜를 가진다', () => {
    const alert: MealAlertCard = {
        id: 'meals.daily.lunch:2026-07-27:lunch-sha',
        period: 'lunch',
        title: '오늘 중식이 올라왔어요',
        preview: '쌀밥 · 김치찌개 · 계란말이',
        dateKey: '2026-07-27',
        publishedAt: '2026-07-27T01:05:00Z',
        createdAt: Date.parse('2026-07-27T01:05:00Z'),
    };

    assert.equal(alert.preview, '쌀밥 · 김치찌개 · 계란말이');
    assert.equal(alert.dateKey, '2026-07-27');
});
