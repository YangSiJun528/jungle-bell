import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {createDashboardApi} from './dashboard-api';

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: {'content-type': 'application/json'},
    });
}

test('공개 생활 정보는 인증 없이 v1 읽기 API만 호출한다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        campusApiBaseUrl: 'https://campus.example.com/',
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            calls.push({url: String(input), init});
            return jsonResponse({
                schemaVersion: 1,
                asOf: '2026-08-03T09:00:00.000Z',
                final: false,
                quality: {
                    collection: 'SUCCESS',
                    sourceFreshness: 'REFRESH_OBSERVED',
                    lastCheckedAt: '2026-08-03T09:00:00.000Z',
                },
                machines: [],
            });
        },
        invokeCommand: async () => undefined,
    });

    const result = await api.getPublicLaundry();

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.capacity, null);
    assert.equal(calls[0]?.url, 'https://campus.example.com/v1/laundry/latest');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(calls[0]?.init?.credentials, 'omit');
    assert.equal(new Headers(calls[0]?.init?.headers).has('authorization'), false);
});

test('세탁 가능 횟수는 서버 authoritative capacity 계약을 엄격히 유지한다', async () => {
    const capacity = {
        basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN',
        men: {
            access: 'men',
            washerAvailable: 4,
            projectedDryerSupply: 5,
            pendingDryerLoads: 2,
            dryerHeadroom: 3,
            startableLoads: 3,
            reliable: true,
        },
        women: {
            access: 'women',
            washerAvailable: 2,
            projectedDryerSupply: 2,
            pendingDryerLoads: 1,
            dryerHeadroom: 1,
            startableLoads: 1,
            reliable: true,
        },
    };
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({
            schemaVersion: 1,
            asOf: '2026-08-03T09:00:00.000Z',
            final: false,
            quality: {
                collection: 'SUCCESS',
                sourceFreshness: 'REFRESH_OBSERVED',
                lastCheckedAt: '2026-08-03T09:00:00.000Z',
            },
            machines: [],
            capacity,
        }),
        invokeCommand: async () => undefined,
    });

    assert.deepEqual((await api.getPublicLaundry()).capacity, capacity);
});

test('서버 capacity가 내부 불변식을 어기면 응답 전체를 거부한다', async () => {
    const base = {
        access: 'men',
        washerAvailable: 4,
        projectedDryerSupply: 5,
        pendingDryerLoads: 2,
        dryerHeadroom: 3,
        startableLoads: 3,
        reliable: true,
    };
    for (const men of [
        {...base, access: 'women'},
        {...base, reliable: false},
        {...base, dryerHeadroom: 4},
        {...base, startableLoads: 4},
        {...base, startableLoads: 1.5},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse({
                schemaVersion: 1,
                asOf: '2026-08-03T09:00:00.000Z',
                final: false,
                quality: {collection: 'SUCCESS', sourceFreshness: 'REFRESH_OBSERVED', lastCheckedAt: null},
                machines: [],
                capacity: {
                    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN',
                    men,
                    women: {...base, access: 'women'},
                },
            }),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getPublicLaundry(), /API_RESPONSE_INVALID/);
    }
});

test('급식 원문 링크는 Kakao HTTPS allowlist만 화면 모델에 남긴다', async () => {
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({
            asOf: '2026-08-03T09:00:00.000Z',
            lastCheckedAt: '2026-08-03T09:00:00.000Z',
            data: {
                dailyMenus: [
                    {id: '1', title: '중식', text: '밥', publishedAt: null, permalink: 'javascript:alert(1)'},
                    {id: '2', title: '석식', text: '밥', publishedAt: null, permalink: 'http://pf.kakao.com/_xhzNjn/114130545'},
                    {id: '3', title: '간식', text: '빵', publishedAt: null, permalink: 'https://evil.example/posts'},
                    {id: '4', title: '야식', text: '죽', publishedAt: null, permalink: 'https://pf.kakao.com:444/_xhzNjn/114130545'},
                    {id: '5', title: '새참', text: '떡', publishedAt: null, permalink: 'https://pf.kakao.com/_other/114130545'},
                    {id: '6', title: '후식', text: '과일', publishedAt: null, permalink: 'https://pf.kakao.com/_xhzNjn/114130545?redirect=1'},
                ],
                pinnedMenus: [],
                recentMenus: [],
            },
        }),
        invokeCommand: async () => undefined,
    });

    const meals = await api.getPublicMeals();

    assert.equal(meals.data.dailyMenus[0]?.permalink, null);
    assert.equal(meals.data.dailyMenus[1]?.permalink, 'https://pf.kakao.com/_xhzNjn/114130545');
    assert.equal(meals.data.dailyMenus[2]?.permalink, null);
    assert.equal(meals.data.dailyMenus[3]?.permalink, null);
    assert.equal(meals.data.dailyMenus[4]?.permalink, null);
    assert.equal(meals.data.dailyMenus[5]?.permalink, null);
});

test('모바일 알림 내역은 서버의 epoch 응답 필드를 그대로 검증한다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            calls.push({url: String(input), init});
            return jsonResponse({
                notifications: [{
                    id: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe',
                    kind: 'attendance-action-required',
                    title: '입실 체크가 필요합니다',
                    body: 'LMS에서 직접 확인해 주세요.',
                    path: '/dashboard.html#attendance',
                    createdAtEpochMs: 1_785_727_000_000,
                    expiresAtEpochMs: 1_785_727_600_000,
                    attempt: 1,
                }],
            });
        },
        invokeCommand: async () => undefined,
    });

    const notifications = await api.getNotifications();

    assert.equal(calls[0]?.url, 'https://platform.example.com/v1/notifications/inbox?limit=20');
    assert.deepEqual(notifications, [{
        id: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe',
        kind: 'attendance-action-required',
        title: '입실 체크가 필요합니다',
        body: 'LMS에서 직접 확인해 주세요.',
        path: '/dashboard.html#attendance',
        createdAtEpochMs: 1_785_727_000_000,
        expiresAtEpochMs: 1_785_727_600_000,
        attempt: 1,
    }]);
});

test('모바일 알림의 위조된 경로나 ISO 문자열 시간은 거부한다', async () => {
    const base = {
        id: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe',
        kind: 'attendance-action-required',
        title: '알림',
        body: '본문',
        createdAtEpochMs: 1_785_727_000_000,
        expiresAtEpochMs: 1_785_727_600_000,
        attempt: 1,
    };
    for (const notification of [
        {...base, path: 'https://evil.example/'},
        {...base, path: '/dashboard.html#unknown'},
        {...base, path: '/dashboard.html#attendance', createdAtEpochMs: '2026-08-03T09:00:00.000Z'},
        {...base, path: '/dashboard.html#attendance', expiresAtEpochMs: undefined},
        {...base, path: '/dashboard.html#attendance', expiresAtEpochMs: Number.MAX_SAFE_INTEGER + 1},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse({notifications: [notification]}),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getNotifications(), /API_RESPONSE_INVALID/);
    }
});

test('개인 API는 쿠키·no-store를 강제하고 bearer는 메모리 provider가 있을 때만 붙인다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com/',
        fetcher: async (input, init) => {
            calls.push({url: String(input), init});
            return jsonResponse({attendance: null, freshness: 'missing'});
        },
        invokeCommand: async () => undefined,
        authorizationProvider: () => 'Bearer in-memory-token',
    });

    await api.getAttendance('companion');

    assert.equal(calls[0]?.url, 'https://platform.example.com/v1/attendance/snapshots');
    assert.equal(calls[0]?.init?.credentials, 'include');
    assert.equal(calls[0]?.init?.cache, 'no-store');
    assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer in-memory-token');
});

test('출석 envelope의 stale freshness를 snapshot과 함께 보존한다', async () => {
    const snapshot = {
        attendanceDate: '2026-08-03',
        cohortId: 'jungle-10',
        cohortStatus: 'active',
        cohortStartDate: '2026-07-01',
        cohortEndDate: '2026-12-31',
        morningChecked: true,
        eveningChecked: false,
        collectedAt: '2026-08-03T09:00:00.000Z',
    };
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({attendance: snapshot, freshness: 'stale'}),
        invokeCommand: async () => undefined,
    });

    const result = await api.getAttendance('companion');

    assert.equal(result.state, 'loaded');
    if (result.state !== 'loaded') return;
    assert.equal(result.attendance.status, 'available');
    assert.equal(result.attendance.freshness, 'stale');
    assert.equal(result.attendance.lastSyncedAt, snapshot.collectedAt);
    assert.deepEqual(result.attendance.snapshot, {
        ...snapshot,
        sourceDeviceId: 'unknown',
        version: 0,
    });
});

test('출석 snapshot에 freshness가 없거나 invalid이면 fresh로 추측하지 않는다', async () => {
    const attendance = {
        attendanceDate: '2026-08-03',
        cohortId: 'jungle-10',
        cohortStatus: 'active',
        cohortStartDate: null,
        cohortEndDate: null,
        morningChecked: true,
        eveningChecked: false,
        collectedAt: '2026-08-03T09:00:00.000Z',
    };
    for (const envelope of [
        {attendance},
        {attendance, freshness: 'missing'},
        {attendance, freshness: 'recent'},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse(envelope),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getAttendance('companion'), /API_RESPONSE_INVALID/);
    }
});

test('데스크톱 개인 기능은 웹 요청 대신 제한된 Tauri command adapter를 쓴다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        fetcher: async () => {
            throw new Error('unexpected fetch');
        },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            if (command === 'get_remote_attendance_snapshot') {
                return {state: 'auth-required'};
            }
            return {state: 'disconnected'};
        },
    });

    await api.getDesktopConnectionState();
    await api.getAttendance('desktop');
    await api.refreshPlatformSync();

    assert.deepEqual(calls.map(({command}) => command), [
        'get_connected_service_status',
        'get_remote_attendance_snapshot',
        'refresh_platform_sync',
    ]);
});

test('모바일 수동 연결 요청에는 정규화한 10자리 코드만 전송한다', async () => {
    const bodies: unknown[] = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return jsonResponse({
                claimId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
                claimReceipt: `jbcr_${'a'.repeat(64)}`,
                status: 'awaiting-desktop-approval',
            });
        },
        invokeCommand: async () => undefined,
    });

    await api.claimManualPairing({
        manualCode: 'abcde-23oil',
        deviceLabel: 'Jungle Bell 모바일',
        installationId: 'jbmi_0123456789abcdef0123456789abcdef',
    });

    assert.equal((bodies[0] as {manualCode: string}).manualCode, 'ABCDE23011');
    assert.equal((bodies[0] as {deviceLabel: string}).deviceLabel, 'Jungle Bell 모바일');
    assert.equal(
        (bodies[0] as {installationId: string}).installationId,
        'jbmi_0123456789abcdef0123456789abcdef',
    );
});

test('데스크톱 생활 정보는 외부 fetch 대신 CampusService IPC를 사용한다', async () => {
    const calls: string[] = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => {
            throw new Error('unexpected fetch');
        },
        invokeCommand: async (command, args) => {
            calls.push(`${command}:${String(args?.kind)}`);
            return args?.kind === 'laundry'
                ? {
                    schemaVersion: 1,
                    asOf: '2026-08-03T09:00:00.000Z',
                    final: false,
                    quality: {collection: 'SUCCESS', sourceFreshness: 'REFRESH_OBSERVED', lastCheckedAt: '2026-08-03T09:00:00.000Z'},
                    machines: [],
                }
                : {
                    asOf: '2026-08-03T09:00:00.000Z',
                    lastCheckedAt: '2026-08-03T09:00:00.000Z',
                    data: {dailyMenus: [], pinnedMenus: [], recentMenus: []},
                };
        },
    });

    await api.getPublicLaundry();
    await api.getPublicMeals();

    assert.deepEqual(calls, [
        'get_dashboard_campus_data:laundry',
        'get_dashboard_campus_data:meals',
    ]);
});

test('데스크톱 페어링 상태는 서버의 expired 종료 상태를 허용한다', async () => {
    const api = createDashboardApi({
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command) => {
            assert.equal(command, 'get_mobile_pairing_status');
            return {status: 'expired', claim: null};
        },
    });

    assert.deepEqual(
        await api.getMobilePairingStatus('jbp_01234567-89ab-4def-8123-456789abcdef'),
        {status: 'expired', claim: null},
    );
});

test('페어링 claim은 claimed 상태에서만 허용한다', async () => {
    for (const status of [
        {status: 'claimed', claim: null},
        {
            status: 'expired',
            claim: {
                claimId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
                deviceLabel: '모바일',
                confirmationCode: 'ABCD',
            },
        },
    ]) {
        const api = createDashboardApi({
            fetcher: async () => { throw new Error('unexpected fetch'); },
            invokeCommand: async () => status,
        });
        await assert.rejects(
            api.getMobilePairingStatus('jbp_01234567-89ab-4def-8123-456789abcdef'),
            /API_RESPONSE_INVALID/,
        );
    }
});

test('페어링 확인 코드는 4자리 ASCII 영문·숫자만 허용한다', async () => {
    for (const confirmationCode of ['ABC', 'ABCDE', 'AB-1', '가나다라']) {
        const api = createDashboardApi({
            fetcher: async () => { throw new Error('unexpected fetch'); },
            invokeCommand: async () => ({
                status: 'claimed',
                claim: {
                    claimId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
                    deviceLabel: '모바일',
                    confirmationCode,
                },
            }),
        });
        await assert.rejects(
            api.getMobilePairingStatus('jbp_01234567-89ab-4def-8123-456789abcdef'),
            /API_RESPONSE_INVALID/,
        );
    }
});

test('인증 토큰을 브라우저 영속 저장소에 기록하지 않는다', () => {
    const source = readFileSync(new URL('./dashboard-api.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:local|session)Storage\.setItem\([^\n]*(?:token|authorization|bearer)/i);
});

test('데스크톱 알림함은 Tauri IPC snapshot을 검증하고 알림 활성화를 전달한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const snapshot = {
        revision: 2,
        unreadCount: 1,
        items: [{
            id: '42',
            title: '오전 출석을 확인해 주세요',
            body: '공식 정글캠퍼스에서 출석 상태를 확인하세요.',
            createdAt: 1_785_727_000_000,
            readAt: null,
            action: 'openAttendance',
        }],
    };
    const api = createDashboardApi({
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            return snapshot;
        },
    });

    assert.deepEqual(await api.getDesktopNotificationInbox(), snapshot);
    assert.deepEqual(await api.activateDesktopNotification('42'), snapshot);
    assert.deepEqual(calls, [
        {command: 'get_notification_inbox_snapshot', args: undefined},
        {command: 'activate_notification', args: {id: '42'}},
    ]);
    await assert.rejects(api.activateDesktopNotification('../42'), /API_CLIENT_INVALID_ARGUMENT/);
});

test('테스트 알림은 PC에서는 OS 알림 IPC, 모바일에서는 인증된 Push API를 사용한다', async () => {
    const invokes: Array<{command: string; args?: Record<string, unknown>}> = [];
    const fetches: Array<{url: string; init?: RequestInit}> = [];
    const snapshot = {
        revision: 1,
        unreadCount: 1,
        items: [{
            id: '1', title: 'Jungle Bell 테스트 알림', body: '정상적으로 연결되었습니다.',
            createdAt: 1_785_727_000_000, readAt: null, action: null,
        }],
    };
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            fetches.push({url: String(input), init});
            return jsonResponse({notificationId: 'test-id', queued: 1}, 202);
        },
        invokeCommand: async (command, args) => {
            invokes.push({command, args});
            return {snapshot, systemDelivered: true, mobileQueued: 2};
        },
    });

    assert.deepEqual(await api.sendDesktopTestNotification(), {snapshot, systemDelivered: true, mobileQueued: 2});
    await api.sendMobileTestNotification();
    assert.deepEqual(invokes, [{command: 'send_test_notification', args: undefined}]);
    assert.equal(fetches[0]?.url, 'https://platform.example.com/v1/notifications/test');
    assert.equal(fetches[0]?.init?.method, 'POST');
    assert.equal(fetches[0]?.init?.credentials, 'include');
});
