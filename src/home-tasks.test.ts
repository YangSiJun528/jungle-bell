import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    homeTaskDismissal,
    homeTaskSubscriptions,
    resolveHomeTasks,
    withoutHomeTask,
} from './home-tasks.ts';
import {EMPTY_LOCAL_DASHBOARD, type LocalDashboardSnapshot} from './local-dashboard.ts';
import type {SettingsSnapshot} from './settings-state.ts';

const subscribedDashboard: LocalDashboardSnapshot = {
    laundry: {
        machineId: 'tower-1',
        machineLabel: '1번',
        appliance: 'washer',
        sessionId: 'session-1',
        notifyBeforeMins: 5,
        status: 'running',
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

test('세탁 추적과 실제 급식 게시 이벤트만 생활 알림 개수에 포함한다', () => {
    const tasks = resolveHomeTasks(subscribedDashboard, {
        laundry: true,
    });

    assert.deepEqual(tasks, {
        laundry: true,
        mealAlerts: 2,
        count: 3,
    });
});

test('대시보드 데이터가 남아 있어도 설정에서 해제된 항목은 다시 표시하지 않는다', () => {
    assert.deepEqual(
        resolveHomeTasks(subscribedDashboard, {laundry: false}),
        {
            laundry: false,
            mealAlerts: 2,
            count: 2,
        },
    );
    assert.deepEqual(
        resolveHomeTasks(EMPTY_LOCAL_DASHBOARD, {laundry: true}),
        {
            laundry: false,
            mealAlerts: 0,
            count: 0,
        },
    );
});

test('설정 스냅샷을 생활 알림 구독 상태로 변환한다', () => {
    const snapshot = {
        laundryWatch: {machineId: 'tower-1'},
        mealSubscription: true,
    } as SettingsSnapshot;

    assert.deepEqual(homeTaskSubscriptions(snapshot), {
        laundry: true,
    });
});

test('닫기 즉시 세탁 생활 알림을 로컬 구독 상태에서 제거할 수 있다', () => {
    const subscriptions = {laundry: true};

    assert.deepEqual(withoutHomeTask(subscriptions, 'laundry'), {
        laundry: false,
    });
    assert.deepEqual(subscriptions, {laundry: true});
});

test('세탁 생활 알림 취소만 기존 설정 해제 명령에 연결한다', () => {
    assert.deepEqual(homeTaskDismissal('laundry'), {
        command: 'set_laundry_watch',
        args: {watch: null},
    });
});
