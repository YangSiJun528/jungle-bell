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

test('PC 홈 overview는 로컬 D-Day와 LMS를 보존하는 exact DTO다', async () => {
    const overview = {
        attendance: {
            status: 'active',
            statusText: '학습 종료 가능 (3시간 49분 남음)',
            ddayText: '수료까지 D-21',
            ddayPeriod: {startDate: '2026-08-01', endDate: '2026-08-31'},
            currentVersion: '0.5.0',
        },
        lmsSessionState: 'connected',
        unreadCount: 2,
        laundry: null,
        meals: null,
    };
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({}),
        invokeCommand: async (command) => command === 'get_dashboard_home_overview' ? overview : null,
    });

    assert.deepEqual(await api.getDashboardHomeOverview(), overview);

    for (const invalid of [
        {...overview, extra: true},
        {...overview, unreadCount: -1},
        {...overview, lmsSessionState: 'authenticated'},
        {...overview, attendance: {...overview.attendance, pendingUpdate: null}},
        {...overview, attendance: {...overview.attendance, ddayPeriod: {startDate: '2026-08-31', endDate: '2026-08-01'}}},
    ]) {
        const invalidApi = createDashboardApi({
            fetcher: async () => jsonResponse({}),
            invokeCommand: async () => invalid,
        });
        await assert.rejects(invalidApi.getDashboardHomeOverview(), /API_RESPONSE_INVALID/);
    }
});

test('공개 생활 정보는 인증 없이 공개 API만 호출한다', async () => {
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
    assert.equal(calls[0]?.url, 'https://campus.example.com/api/public/laundry');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(calls[0]?.init?.credentials, 'omit');
    assert.equal(new Headers(calls[0]?.init?.headers).has('authorization'), false);
});

test('PC 생활 정보 수동 새로고침은 캐시 조회가 아닌 전용 IPC를 호출한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => jsonResponse({}),
        invokeCommand: async (command, args) => {
            calls.push({command, args});
        },
    });

    await api.refreshCampusData('laundry');
    await api.refreshCampusData('meals');

    assert.deepEqual(calls, [
        {command: 'refresh_campus_data', args: {kind: 'laundry'}},
        {command: 'refresh_campus_data', args: {kind: 'meals'}},
    ]);
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

test('급식 응답의 아카이브 이미지와 주간 식단을 검증해 보존한다', async () => {
    const sha = 'a'.repeat(64);
    const post = {
        id: 'meal-1',
        title: '8월 11일(화) 중식 메뉴',
        text: '잡곡밥, 육개장',
        publishedAt: '2026-08-11T02:00:00.000Z',
        permalink: 'https://pf.kakao.com/_xhzNjn/114222378',
        images: [{
            sha,
            url: `https://campus.example.com/api/public/assets/${sha}.jpg`,
            contentType: 'image/jpeg',
            extension: 'jpg',
            width: 1600,
            height: 1200,
            byteLength: 120_000,
        }],
    };
    const api = createDashboardApi({
        campusApiBaseUrl: 'https://campus.example.com',
        fetcher: async () => jsonResponse({
            asOf: '2026-08-11T09:00:00.000Z',
            lastCheckedAt: '2026-08-11T09:00:00.000Z',
            data: {
                dailyMenus: [post],
                pinnedMenus: [],
                recentMenus: [post],
                currentWeeklyMenu: {
                    targetWeekKey: '2026-08-10',
                    status: 'AVAILABLE',
                    contentSha: sha,
                    post,
                },
                weeklyMenus: [{weekKey: '2026-08-10', contentSha: sha, post}],
                historyNextBefore: '2026-07-01T00:00:00.000Z~meal-30',
            },
        }),
        invokeCommand: async () => undefined,
    });

    const meals = await api.getPublicMeals();

    assert.equal(meals.data.dailyMenus[0]?.images?.[0]?.url,
        `https://campus.example.com/api/public/assets/${sha}.jpg`);
    assert.equal(meals.data.currentWeeklyMenu?.targetWeekKey, '2026-08-10');
    assert.equal(meals.data.weeklyMenus?.[0]?.post.id, 'meal-1');
    assert.equal(meals.data.historyNextBefore, '2026-07-01T00:00:00.000Z~meal-30');
});

test('급식 이미지는 검증된 공개 asset 경로만 허용한다', async () => {
    const sha = 'b'.repeat(64);
    const validImage = {
        sha,
        url: `https://campus.example.com/api/public/assets/${sha}.jpg`,
        contentType: 'image/jpeg',
        extension: 'jpg',
        width: 1,
        height: 1,
        byteLength: 1,
    };
    for (const image of [
        {...validImage, url: `https://evil.example/api/public/assets/${sha}.jpg`},
        {...validImage, url: `https://campus.example.com/tracker/${sha}.jpg`},
        {...validImage, url: `${validImage.url}?token=secret`},
        {...validImage, url: `https://campus.example.com/api/public/assets/${'c'.repeat(64)}.jpg`},
        {...validImage, extension: 'svg', contentType: 'image/svg+xml'},
        {...validImage, width: 20_001},
        {...validImage, byteLength: 0},
    ]) {
        const api = createDashboardApi({
            campusApiBaseUrl: 'https://campus.example.com',
            fetcher: async () => jsonResponse({
                asOf: '2026-08-11T09:00:00.000Z',
                lastCheckedAt: null,
                data: {
                    dailyMenus: [{
                        id: 'meal-1', title: '중식', text: '밥', publishedAt: null, permalink: null,
                        images: [image],
                    }],
                    pinnedMenus: [],
                    recentMenus: [],
                },
            }),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getPublicMeals(), /API_RESPONSE_INVALID/);
    }
});

test('과거 급식 페이지는 웹에서 검증된 커서로 공개 API를 호출한다', async () => {
    const calls: string[] = [];
    const api = createDashboardApi({
        campusApiBaseUrl: 'https://campus.example.com',
        fetcher: async (input) => {
            calls.push(String(input));
            return jsonResponse({posts: [], nextBefore: '2026-07-31T02:03:04.000Z~meal-1'});
        },
        invokeCommand: async () => undefined,
    });

    assert.deepEqual(await api.getPublicMealHistory('2026-08-01T02:03:04.000Z~meal-30', 30), {
        posts: [],
        nextBefore: '2026-07-31T02:03:04.000Z~meal-1',
    });
    assert.equal(calls[0],
        'https://campus.example.com/api/public/meals/history?before=2026-08-01T02%3A03%3A04.000Z%7Emeal-30&limit=30');
    await assert.rejects(api.getPublicMealHistory('2026-08-01T02:03:04.000Z', 30), /API_CLIENT_INVALID_ARGUMENT/);
    await assert.rejects(api.getPublicMealHistory('not-a-date', 30), /API_CLIENT_INVALID_ARGUMENT/);
    await assert.rejects(api.getPublicMealHistory(null, 0), /API_CLIENT_INVALID_ARGUMENT/);
});

test('데스크톱 과거 급식 페이지는 외부 origin 대신 Rust IPC를 사용한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => jsonResponse({}),
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            return {posts: [], nextBefore: null};
        },
    });

    await api.getPublicMealHistory(null, 50);

    assert.deepEqual(calls, [{
        command: 'get_dashboard_meal_history',
        args: {before: null, limit: 50},
    }]);
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

    assert.equal(calls[0]?.url, 'https://platform.example.com/api/mobile/notifications?limit=20');
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

test('개인 API는 HttpOnly 쿠키·no-store를 강제하고 Authorization을 만들지 않는다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com/',
        fetcher: async (input, init) => {
            calls.push({url: String(input), init});
            return jsonResponse({attendance: null, freshness: 'missing', devices: []});
        },
        invokeCommand: async () => undefined,
    });

    await api.getAttendance('companion');

    assert.equal(calls[0]?.url, 'https://platform.example.com/api/mobile/attendance');
    assert.equal(calls[0]?.init?.credentials, 'include');
    assert.equal(calls[0]?.init?.cache, 'no-store');
    assert.equal(new Headers(calls[0]?.init?.headers).has('authorization'), false);
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
        fetcher: async () => jsonResponse({attendance: snapshot, freshness: 'stale', devices: [{
            id: 'desktop-1', deviceLabel: 'PC 앱', lastSeenAt: '2026-08-03T09:01:00.000Z',
            lmsSessionState: 'connected', health: 'online', appVersion: '0.5.0',
        }]}),
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
    });
    assert.equal(result.devices[0]?.lmsSessionState, 'connected');
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
        {attendance, devices: []},
        {attendance, freshness: 'missing', devices: []},
        {attendance, freshness: 'recent', devices: []},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse(envelope),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getAttendance('companion'), /API_RESPONSE_INVALID/);
    }
});

test('개인 출석 envelope는 current-only 필드 외의 호환 필드를 거부한다', async () => {
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({
            attendance: null,
            freshness: 'missing',
            devices: [],
            snapshots: [],
        }),
        invokeCommand: async () => undefined,
    });

    await assert.rejects(api.getAttendance('companion'), /API_RESPONSE_INVALID/);
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
                return {attendance: null, freshness: 'missing'};
            }
            return {
                authenticated: true,
                installationId: '550e8400-e29b-41d4-a716-446655440000',
                credentialPersistent: true,
                identityResetRequired: false,
                lmsSessionState: 'connected',
                lastServerContact: '2026-08-03T09:00:00.000Z',
                lastError: null,
            };
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

test('데스크톱 credential 복구는 명시적 확인이 포함된 새 identity command만 사용한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            return {
                authenticated: true,
                installationId: '550e8400-e29b-41d4-a716-446655440000',
                credentialPersistent: true,
                identityResetRequired: false,
                lmsSessionState: 'unknown',
                lastServerContact: '2026-08-03T09:00:00.000Z',
                lastError: null,
            };
        },
    });

    assert.equal((await api.resetDesktopIdentity()).state, 'connected');
    assert.deepEqual(calls, [{command: 'reset_desktop_identity', args: {confirmed: true}}]);
});

test('모바일 수동 연결 요청에는 정규화한 10자리 코드만 전송한다', async () => {
    const bodies: unknown[] = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return jsonResponse({
                claimId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
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

test('데스크톱 모바일 session 목록은 current 배열 DTO만 허용한다', async () => {
    const device = {
        deviceId: 'jbsi_01234567-89ab-4def-8123-456789abcdef',
        deviceLabel: 'Jungle Bell 모바일',
        installationId: 'jbmi_0123456789abcdef0123456789abcdef',
        createdAt: '2026-08-03T09:00:00.000Z',
        expiresAt: '2027-08-03T09:00:00.000Z',
        lastSeenAt: '2026-08-03T09:01:00.000Z',
        pushEnabled: true,
        status: 'active',
    };
    const validApi = createDashboardApi({
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async () => [device],
    });
    assert.deepEqual(await validApi.listMobileSessions(), [device]);

    for (const response of [
        {sessions: [device]},
        [{...device, sessionId: device.deviceId}],
    ]) {
        const api = createDashboardApi({
            fetcher: async () => { throw new Error('unexpected fetch'); },
            invokeCommand: async () => response,
        });
        await assert.rejects(api.listMobileSessions(), /API_RESPONSE_INVALID/);
    }
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
            return jsonResponse({notificationId: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe', queued: 1}, 202);
        },
        invokeCommand: async (command, args) => {
            invokes.push({command, args});
            return {snapshot, systemDelivered: true, mobileQueued: 2};
        },
    });

    assert.deepEqual(await api.sendDesktopTestNotification(), {snapshot, systemDelivered: true, mobileQueued: 2});
    await api.sendMobileTestNotification();
    assert.deepEqual(invokes, [{command: 'send_test_notification', args: undefined}]);
    assert.equal(fetches[0]?.url, 'https://platform.example.com/api/mobile/notifications/test');
    assert.equal(fetches[0]?.init?.method, 'POST');
    assert.equal(fetches[0]?.init?.credentials, 'include');
});

const mealPreferences = {
    enabled: true,
    breakfast: false,
    lunch: true,
    dinner: true,
    updatedAtEpochMs: 1_785_727_000_000,
};

const attendancePreferences = {
    morning: true,
    evening: true,
    skipSunday: false,
    skipAttendanceDate: null,
};

const laundryWatch = {
    id: `jbw_${'a'.repeat(64)}`,
    machineId: '워시타워_1',
    appliance: 'washer' as const,
    sessionId: 'session-1',
    notifyBeforeMinutes: 10,
    notifyWhenAvailable: true,
    status: 'active' as const,
    createdAtEpochMs: 1_785_727_000_000,
    updatedAtEpochMs: 1_785_727_000_001,
};

const laundryQueueEntry = {
    id: `jbq_${'b'.repeat(64)}`,
    machineId: null,
    appliance: 'dryer' as const,
    status: 'waiting' as const,
    joinedAtEpochMs: 1_785_727_000_000,
    leftAtEpochMs: null,
    position: 2,
};

test('데스크톱 최소 설정은 canonical current-only commands와 exact DTO를 사용한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            return {autoStart: command === 'update_desktop_settings'};
        },
    });

    assert.deepEqual(await api.getDesktopSettings(), {autoStart: false});
    assert.deepEqual(await api.updateDesktopSettings({autoStart: true}), {autoStart: true});
    assert.deepEqual(calls, [
        {command: 'get_desktop_settings', args: undefined},
        {command: 'update_desktop_settings', args: {input: {autoStart: true}}},
    ]);
});

test('데스크톱 최소 설정은 unknown field와 non-boolean을 거부한다', async () => {
    for (const response of [
        {autoStart: false, analytics: true},
        {autoStart: 'true'},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => { throw new Error('unexpected fetch'); },
            invokeCommand: async () => response,
        });
        await assert.rejects(api.getDesktopSettings(), /API_RESPONSE_INVALID/);
    }
});

test('데스크톱 개인 생활 설정은 canonical Tauri commands와 strict DTO만 사용한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            if (command === 'get_meal_preferences' || command === 'update_meal_preferences') {
                return mealPreferences;
            }
            if (command === 'get_attendance_preferences' || command === 'update_attendance_preferences') {
                return attendancePreferences;
            }
            if (command === 'list_laundry_watches') return {watches: [laundryWatch]};
            if (command === 'create_laundry_watch') return laundryWatch;
            if (command === 'list_laundry_queue') return {entries: [laundryQueueEntry]};
            if (command === 'join_laundry_queue') return laundryQueueEntry;
            return undefined;
        },
    });

    assert.deepEqual(await api.getAttendancePreferences('desktop'), attendancePreferences);
    assert.deepEqual(await api.updateAttendancePreferences('desktop', {
        morning: false, evening: true, skipSunday: true, skipAttendanceDate: '2026-08-10',
    }), attendancePreferences);
    assert.deepEqual(await api.getMealPreferences('desktop'), mealPreferences);
    assert.deepEqual(await api.updateMealPreferences('desktop', {
        enabled: true, breakfast: false, lunch: true, dinner: true,
    }), mealPreferences);
    assert.deepEqual(await api.listLaundryWatches('desktop'), [laundryWatch]);
    assert.deepEqual(await api.createLaundryWatch('desktop', {
        machineId: '워시타워_1', appliance: 'washer', sessionId: 'session-1',
        notifyBeforeMinutes: 10, notifyWhenAvailable: true,
    }), laundryWatch);
    await api.deleteLaundryWatch('desktop', laundryWatch.id);
    assert.deepEqual(await api.listLaundryQueue('desktop'), [laundryQueueEntry]);
    assert.deepEqual(await api.joinLaundryQueue('desktop', {
        machineId: null, appliance: 'dryer',
    }), laundryQueueEntry);
    await api.leaveLaundryQueue('desktop', laundryQueueEntry.id);

    assert.deepEqual(calls, [
        {command: 'get_attendance_preferences', args: undefined},
        {command: 'update_attendance_preferences', args: {input: {
            morning: false, evening: true, skipSunday: true, skipAttendanceDate: '2026-08-10',
        }}},
        {command: 'get_meal_preferences', args: undefined},
        {command: 'update_meal_preferences', args: {input: {
            enabled: true, breakfast: false, lunch: true, dinner: true,
        }}},
        {command: 'list_laundry_watches', args: undefined},
        {command: 'create_laundry_watch', args: {input: {
            machineId: '워시타워_1', appliance: 'washer', sessionId: 'session-1',
            notifyBeforeMinutes: 10, notifyWhenAvailable: true,
        }}},
        {command: 'delete_laundry_watch', args: {watchId: laundryWatch.id}},
        {command: 'list_laundry_queue', args: undefined},
        {command: 'join_laundry_queue', args: {input: {machineId: null, appliance: 'dryer'}}},
        {command: 'leave_laundry_queue', args: {entryId: laundryQueueEntry.id}},
    ]);
});

test('PWA 개인 생활 설정은 mobile canonical API와 HttpOnly cookie만 사용한다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            const url = String(input);
            calls.push({url, init});
            if (url.endsWith('/attendance/preferences')) return jsonResponse(attendancePreferences);
            if (url.endsWith('/meal-preferences')) return jsonResponse(mealPreferences);
            if (url.endsWith('/laundry-watches') && init?.method === 'GET') {
                return jsonResponse({watches: [laundryWatch]});
            }
            if (url.endsWith('/laundry-watches')) return jsonResponse(laundryWatch, 201);
            if (url.endsWith(`/laundry-watches/${laundryWatch.id}`)) return new Response(null, {status: 204});
            if (url.endsWith('/laundry-queue') && init?.method === 'GET') {
                return jsonResponse({entries: [laundryQueueEntry]});
            }
            if (url.endsWith('/laundry-queue')) return jsonResponse(laundryQueueEntry, 201);
            if (url.endsWith(`/laundry-queue/${laundryQueueEntry.id}`)) return new Response(null, {status: 204});
            throw new Error(`unexpected URL: ${url}`);
        },
        invokeCommand: async () => { throw new Error('unexpected invoke'); },
    });

    await api.getAttendancePreferences('companion');
    await api.updateAttendancePreferences('companion', {
        morning: true, evening: false, skipSunday: true, skipAttendanceDate: null,
    });
    await api.getMealPreferences('companion');
    await api.updateMealPreferences('companion', {
        enabled: false, breakfast: false, lunch: true, dinner: false,
    });
    await api.listLaundryWatches('companion');
    await api.createLaundryWatch('companion', {
        machineId: '워시타워_1', appliance: 'washer', sessionId: null,
        notifyBeforeMinutes: 0, notifyWhenAvailable: true,
    });
    await api.deleteLaundryWatch('companion', laundryWatch.id);
    await api.listLaundryQueue('companion');
    await api.joinLaundryQueue('companion', {machineId: null, appliance: 'dryer'});
    await api.leaveLaundryQueue('companion', laundryQueueEntry.id);

    assert.deepEqual(calls.map(({url, init}) => ({
        path: new URL(url).pathname,
        method: init?.method,
        credentials: init?.credentials,
        authorization: new Headers(init?.headers).has('authorization'),
    })), [
        {path: '/api/mobile/attendance/preferences', method: 'GET', credentials: 'include', authorization: false},
        {path: '/api/mobile/attendance/preferences', method: 'PUT', credentials: 'include', authorization: false},
        {path: '/api/mobile/meal-preferences', method: 'GET', credentials: 'include', authorization: false},
        {path: '/api/mobile/meal-preferences', method: 'PUT', credentials: 'include', authorization: false},
        {path: '/api/mobile/laundry-watches', method: 'GET', credentials: 'include', authorization: false},
        {path: '/api/mobile/laundry-watches', method: 'POST', credentials: 'include', authorization: false},
        {path: `/api/mobile/laundry-watches/${laundryWatch.id}`, method: 'DELETE', credentials: 'include', authorization: false},
        {path: '/api/mobile/laundry-queue', method: 'GET', credentials: 'include', authorization: false},
        {path: '/api/mobile/laundry-queue', method: 'POST', credentials: 'include', authorization: false},
        {path: `/api/mobile/laundry-queue/${laundryQueueEntry.id}`, method: 'DELETE', credentials: 'include', authorization: false},
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
        morning: true, evening: false, skipSunday: true, skipAttendanceDate: null,
    });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
        enabled: false, breakfast: false, lunch: true, dinner: false,
    });
});

test('개인 생활 설정 DTO는 unknown field와 깨진 상태 불변식을 거부한다', async () => {
    const invalidResponses = [
        {...attendancePreferences, skipAttendanceDate: '2026-02-30'},
        {...mealPreferences, legacyAlias: true},
        {watches: [{...laundryWatch, id: 'watch-1'}]},
        {watches: [{...laundryWatch, updatedAtEpochMs: laundryWatch.createdAtEpochMs - 1}]},
        {entries: [{...laundryQueueEntry, position: null}]},
        {entries: [{...laundryQueueEntry, status: 'claimed', leftAtEpochMs: null, position: null}]},
    ];
    const operations = ['attendance', 'meal', 'watches', 'watches', 'queue', 'queue'] as const;
    for (let index = 0; index < invalidResponses.length; index += 1) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse(invalidResponses[index]),
            invokeCommand: async () => undefined,
        });
        const operation = operations[index];
        await assert.rejects(
            operation === 'attendance'
                ? api.getAttendancePreferences('companion')
                : operation === 'meal'
                ? api.getMealPreferences('companion')
                : operation === 'watches'
                    ? api.listLaundryWatches('companion')
                    : api.listLaundryQueue('companion'),
            /API_RESPONSE_INVALID/,
        );
    }
});

test('pairing complete는 receipt를 JSON에 노출하지 않고 HttpOnly pending cookie만 사용한다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            calls.push({url: String(input), init});
            return new Response(null, {status: 204});
        },
        invokeCommand: async () => undefined,
    });

    assert.equal(
        await api.completePairing('jbp_01234567-89ab-4def-8123-456789abcdef'),
        'completed',
    );
    assert.equal(calls[0]?.url, 'https://platform.example.com/api/pairings/jbp_01234567-89ab-4def-8123-456789abcdef/complete');
    assert.equal(calls[0]?.init?.credentials, 'include');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {});
    assert.doesNotMatch(String(calls[0]?.init?.body), /receipt|token|bearer/i);
});

test('pairing complete는 canonical 204 응답만 성공으로 처리한다', async () => {
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({}, 200),
        invokeCommand: async () => undefined,
    });
    await assert.rejects(
        api.completePairing('jbp_01234567-89ab-4def-8123-456789abcdef'),
        /API_RESPONSE_INVALID/,
    );
});
