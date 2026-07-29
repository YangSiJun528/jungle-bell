import assert from 'node:assert/strict';
import {test} from 'vitest';

import {resolveHomeTasks} from './home-tasks.ts';
import {EMPTY_LOCAL_DASHBOARD, type LocalDashboardSnapshot} from './local-dashboard.ts';

const subscribedDashboard: LocalDashboardSnapshot = {
    laundry: {
        machineId: 'tower-1',
        machineLabel: '1번',
        appliance: 'washer',
        sessionId: 'session-1',
        notifyBeforeMins: 5,
        status: 'running',
        totalMinutes: 60,
        estimatedFinishAt: '2026-07-27T12:00:00+09:00',
        updatedAt: null,
        sourceFreshness: null,
    },
    mealAlerts: [
        {
            id: 'lunch-1',
            period: 'lunch',
            title: '오늘 중식이 올라왔어요',
            preview: '쌀밥 · 김치찌개',
            dateKey: '2026-07-27',
            publishedAt: null,
            createdAt: 1,
        },
        {
            id: 'dinner-1',
            period: 'dinner',
            title: '오늘 석식이 올라왔어요',
            preview: '카레라이스 · 샐러드',
            dateKey: '2026-07-27',
            publishedAt: null,
            createdAt: 2,
        },
    ],
};

test('생활 알림 개수에는 완료 후 쌓인 급식 게시 이벤트만 포함한다', () => {
    const tasks = resolveHomeTasks(subscribedDashboard);

    assert.deepEqual(tasks, {
        mealAlerts: 2,
        count: 2,
    });
});

test('진행 중인 세탁만 있고 급식 게시 이벤트가 없으면 생활 알림은 비어 있다', () => {
    assert.deepEqual(resolveHomeTasks({
        ...EMPTY_LOCAL_DASHBOARD,
        laundry: subscribedDashboard.laundry,
    }), {
        mealAlerts: 0,
        count: 0,
    });
});
