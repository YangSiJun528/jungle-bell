import assert from 'node:assert/strict';
import {afterEach, test, vi} from 'vitest';

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(),
    unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: tauriMocks.listen,
}));

import {
    applyRefreshedSettingsSnapshot,
    applySettingsSnapshot,
    connectRequiredSettingsSnapshots,
    type SettingsSnapshot,
} from './settings-state';

afterEach(() => {
    vi.clearAllMocks();
});

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
        notificationDelivery: 'both',
        notificationStart: {hour: 9, minute: 0},
        notificationEnd: {hour: 4, minute: 0},
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

test('필수 설정 연결은 이벤트 구독 실패를 호출자에게 전달하고 기본 snapshot을 조회하지 않는다', async () => {
    const target = {settingsRevision: -1};
    tauriMocks.listen.mockRejectedValueOnce(new Error('listen failed'));

    await assert.rejects(
        connectRequiredSettingsSnapshots(target, () => undefined),
        /event subscription/,
    );
    assert.equal(tauriMocks.invoke.mock.calls.length, 0);
    assert.equal(target.settingsRevision, -1);
});

test('필수 설정 연결은 초기 snapshot 실패 시 등록한 구독을 해제하고 오류를 전달한다', async () => {
    const target = {settingsRevision: -1};
    tauriMocks.listen.mockResolvedValueOnce(tauriMocks.unlisten);
    tauriMocks.invoke.mockRejectedValueOnce(new Error('snapshot failed'));

    await assert.rejects(
        connectRequiredSettingsSnapshots(target, () => undefined),
        /snapshot refresh/,
    );
    assert.equal(tauriMocks.unlisten.mock.calls.length, 1);
    assert.equal(target.settingsRevision, -1);
});

test('필수 설정 연결 재시도가 성공하면 authoritative snapshot을 적용하고 구독을 유지한다', async () => {
    const target = {settingsRevision: -1, autoStart: false};
    const expected = snapshot(4, true);
    tauriMocks.listen.mockResolvedValueOnce(tauriMocks.unlisten);
    tauriMocks.invoke.mockResolvedValueOnce(expected);

    const unlisten = await connectRequiredSettingsSnapshots(target, (targetValue, value) => {
        targetValue.autoStart = value.autoStart;
    });

    assert.equal(unlisten, tauriMocks.unlisten);
    assert.equal(target.settingsRevision, 4);
    assert.equal(target.autoStart, true);
    assert.equal(tauriMocks.unlisten.mock.calls.length, 0);
});
