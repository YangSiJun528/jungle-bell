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
    meals: {
        targetWeekKey: '2026-W31',
        title: '7월 5주차',
        status: 'available',
        lunchTitle: '중식',
        dinnerTitle: '석식',
        updatedAt: null,
    },
};

test('세탁 추적과 급식 구독만 생활 알림 개수에 포함한다', () => {
    const tasks = resolveHomeTasks(subscribedDashboard, {
        laundry: true,
        meals: true,
    });

    assert.deepEqual(tasks, {
        laundry: true,
        meals: true,
        count: 2,
    });
});

test('대시보드 데이터가 남아 있어도 설정에서 해제된 항목은 다시 표시하지 않는다', () => {
    assert.deepEqual(
        resolveHomeTasks(subscribedDashboard, {laundry: false, meals: false}),
        {
            laundry: false,
            meals: false,
            count: 0,
        },
    );
    assert.deepEqual(
        resolveHomeTasks(EMPTY_LOCAL_DASHBOARD, {laundry: true, meals: true}),
        {
            laundry: false,
            meals: false,
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
        meals: true,
    });
});

test('닫기 즉시 해당 생활 알림을 로컬 구독 상태에서 제거할 수 있다', () => {
    const subscriptions = {laundry: true, meals: true};

    assert.deepEqual(withoutHomeTask(subscriptions, 'laundry'), {
        laundry: false,
        meals: true,
    });
    assert.deepEqual(withoutHomeTask(subscriptions, 'meals'), {
        laundry: true,
        meals: false,
    });
    assert.deepEqual(subscriptions, {laundry: true, meals: true});
});

test('취소 가능한 생활 알림은 기존 설정 해제 명령에 연결한다', () => {
    assert.deepEqual(homeTaskDismissal('laundry'), {
        command: 'set_laundry_watch',
        args: {watch: null},
    });
    assert.deepEqual(homeTaskDismissal('meals'), {
        command: 'set_meal_subscription_enabled',
        args: {enabled: false},
    });
});
