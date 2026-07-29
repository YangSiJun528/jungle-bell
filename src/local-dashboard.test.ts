import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    dashboardDataIsStale,
    EMPTY_LOCAL_DASHBOARD,
    laundryDashboardExpectedEnd,
    laundryDashboardProgress,
    laundryDashboardRemaining,
    laundryTerminalActivityDateTime,
    laundryTerminalActivityDetail,
    laundryTerminalActivityTitle,
    laundryTerminalActivityTone,
    laundryTerminalActivityTime,
    type LaundryDashboardCard,
    type LaundryTerminalActivity,
} from './local-dashboard';

function laundry(overrides: Partial<LaundryDashboardCard> = {}): LaundryDashboardCard {
    return {
        machineId: 'tower6',
        machineLabel: '6번 기기',
        appliance: 'washer',
        sessionId: 'session-1',
        notifyBeforeMins: 5,
        status: 'running',
        totalMinutes: 60,
        estimatedFinishAt: '2026-07-27T09:05:00Z',
        updatedAt: Date.parse('2026-07-27T09:00:00Z'),
        sourceFreshness: 'WITHIN_REFRESH_WINDOW',
        ...overrides,
    };
}

function terminal(
    overrides: Partial<LaundryTerminalActivity> = {},
): LaundryTerminalActivity {
    return {
        id: 'activity-1',
        machineId: 'tower6',
        machineLabel: '6번 기기',
        appliance: 'washer',
        sessionId: 'session-1',
        status: 'completed',
        finishedAt: Date.parse('2026-07-27T09:05:00Z'),
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

test('진행 카드에는 한국 시각 기준 예상 종료 시각을 함께 표시한다', () => {
    assert.equal(laundryDashboardExpectedEnd(laundry()), '18:05 예상 종료');
    assert.equal(
        laundryDashboardExpectedEnd(laundry({estimatedFinishAt: null})),
        '',
    );
});

test('총 소요시간을 확인한 실행에만 실제 세탁 진행률을 표시한다', () => {
    const card = laundry({estimatedFinishAt: '2026-07-27T09:30:00Z'});

    assert.equal(
        laundryDashboardProgress(card, Date.parse('2026-07-27T09:00:00Z')),
        50,
    );
    assert.equal(
        laundryDashboardProgress({...card, status: 'completed'}, Date.parse('2026-07-27T09:00:00Z')),
        100,
    );
    assert.equal(
        laundryDashboardProgress({...card, status: 'awaitingCompletion'}, Date.parse('2026-07-27T09:00:00Z')),
        100,
    );
    assert.equal(
        laundryDashboardProgress({...card, status: 'paused'}, Date.parse('2026-07-27T09:00:00Z')),
        null,
    );
    assert.equal(
        laundryDashboardProgress({...card, totalMinutes: null}, Date.parse('2026-07-27T09:00:00Z')),
        null,
    );
});

test('홈 카드는 종류별 허용 시간보다 오래되면 지연 상태를 표시한다', () => {
    assert.equal(dashboardDataIsStale(Date.parse('2026-07-27T09:00:00Z'), Date.parse('2026-07-27T09:02:01Z'), 120_000), true);
    assert.equal(dashboardDataIsStale(Date.parse('2026-07-27T09:00:00Z'), Date.parse('2026-07-27T09:01:00Z'), 120_000), false);
});

test('로컬 홈 대시보드는 활성 추적과 확인할 종료 항목을 분리한다', () => {
    assert.deepEqual(EMPTY_LOCAL_DASHBOARD, {
        laundry: null,
        laundryTerminalActivities: [],
    });
});

test('종료된 세탁은 결과별 행동 문구와 톤을 제공한다', () => {
    assert.equal(laundryTerminalActivityTitle(terminal()), '세탁 완료');
    assert.equal(laundryTerminalActivityTone(terminal()), 'success');
    assert.match(laundryTerminalActivityDetail(terminal()), /꺼냈다면.*제거/);

    const errored = terminal({appliance: 'dryer', status: 'error'});
    assert.equal(laundryTerminalActivityTitle(errored), '건조기 오류');
    assert.equal(laundryTerminalActivityTone(errored), 'danger');
    assert.match(laundryTerminalActivityDetail(errored), /상태를 확인한 뒤.*제거/);

    assert.equal(
        laundryTerminalActivityTitle(terminal({status: 'needsCheck'})),
        '세탁 상태 확인',
    );
    assert.equal(
        laundryTerminalActivityTone(terminal({status: 'needsCheck'})),
        'warning',
    );
    assert.equal(
        laundryTerminalActivityTitle(terminal({status: 'replaced'})),
        '세탁 추적 종료',
    );
});

test('종료된 세탁은 저장된 시각을 한국 시각으로 표시한다', () => {
    assert.equal(
        laundryTerminalActivityTime(
            terminal(),
            Date.parse('2026-07-27T09:06:00Z'),
        ),
        '18:05 감지',
    );
    assert.equal(
        laundryTerminalActivityTime(
            terminal(),
            Date.parse('2026-07-29T09:06:00Z'),
        ),
        '7.27.',
    );
    assert.equal(
        laundryTerminalActivityDateTime(terminal()),
        '2026-07-27T09:05:00.000Z',
    );
    assert.equal(laundryTerminalActivityTime(terminal({finishedAt: Number.NaN})), '');
});
