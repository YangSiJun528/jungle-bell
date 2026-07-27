import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    applyRefreshedSettingsSnapshot,
    applySettingsSnapshot,
    type SettingsSnapshot,
} from './settings-state';

function snapshot(revision: number, autoStart: boolean): SettingsSnapshot {
    return {
        revision,
        source: 'settings',
        appVersion: '0.4.4',
        pendingVersion: null,
        autoStart,
        autoUpdate: true,
        showAppIcon: true,
        showDday: true,
        usageAnalytics: true,
        debugMode: false,
        skipAttendance: false,
        skipSunday: false,
        startNotification: true,
        endNotification: true,
        notificationStart: {hour: 9, minute: 0},
        notificationEnd: {hour: 4, minute: 0},
        startInterval: 15,
        endInterval: 15,
        selectedCohortId: null,
        effectiveCohortId: null,
        cohortOptions: [],
        mealSubscription: false,
        laundryWatch: null,
    };
}

test('snapshot/event 순서가 뒤집혀도 가장 높은 revision만 적용한다', () => {
    const target = {settingsRevision: -1};
    const applied: boolean[] = [];

    assert.equal(
        applySettingsSnapshot(target, snapshot(2, false), (value) => {
            applied.push(value.autoStart);
        }),
        true,
    );
    assert.equal(
        applySettingsSnapshot(target, snapshot(1, true), (value) => {
            applied.push(value.autoStart);
        }),
        false,
    );
    assert.equal(
        applySettingsSnapshot(target, snapshot(2, true), (value) => {
            applied.push(value.autoStart);
        }),
        false,
    );

    assert.equal(target.settingsRevision, 2);
    assert.deepEqual(applied, [false]);
});

test('저장 실패 복구 조회는 같은 revision도 authoritative 값으로 다시 적용한다', () => {
    const target = {settingsRevision: 3};
    const applied: boolean[] = [];

    assert.equal(
        applyRefreshedSettingsSnapshot(target, snapshot(3, true), (value) => {
            applied.push(value.autoStart);
        }),
        true,
    );
    assert.equal(
        applyRefreshedSettingsSnapshot(target, snapshot(2, false), (value) => {
            applied.push(value.autoStart);
        }),
        false,
    );

    assert.deepEqual(applied, [true]);
    assert.equal(target.settingsRevision, 3);
});
