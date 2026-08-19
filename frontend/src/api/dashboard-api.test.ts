import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {
    createDashboardApi as createDashboardApiImplementation,
    type DashboardApiOptions,
} from './dashboard-api';
import {createNativeBridge} from '@/platform/tauri/native-bridge';
import {createTauriPlatformAdapter} from '@/platform/tauri/adapter';
import {createWebPlatformAdapter} from '@/platform/web/adapter';
import {
    type NativeInvoke,
    unavailableEventAdapter,
    unavailablePwaAdapter,
} from '@/platform/contracts';

type TestDashboardApiOptions = DashboardApiOptions & {
    desktopRuntime?: boolean;
    installedPwa?: boolean;
    invokeCommand?: NativeInvoke;
};

function createDashboardApi(options: TestDashboardApiOptions = {}) {
    const {desktopRuntime = false, installedPwa = true, invokeCommand, ...implementationOptions} = options;
    const nativeBridge = desktopRuntime
        ? createNativeBridge(invokeCommand)
        : undefined;
    return createDashboardApiImplementation({
        ...implementationOptions,
        platformAdapter: desktopRuntime
            ? createTauriPlatformAdapter({
                nativeBridge,
                events: unavailableEventAdapter(),
            })
            : createWebPlatformAdapter({
                ...unavailablePwaAdapter(),
                available: true,
                installed: installedPwa,
            }),
    });
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: {'content-type': 'application/json'},
    });
}

function desktopHttpSession() {
    return {
        accessToken: `jbui_${'a'.repeat(64)}`,
        expiresAt: new Date(Date.now() + 7 * 60_000).toISOString(),
    };
}

test('브라우저 계정 세션은 401을 정상적인 미연결 상태로 처리한다', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        fetcher: async (input, init) => {
            calls.push({url: String(input), init});
            return new Response(null, {status: 401});
        },
    });

    assert.equal(await api.getAccountSession(), null);
    assert.equal(calls[0]?.url, '/api/me/session');
    assert.equal(calls[0]?.init?.credentials, 'include');
    assert.equal(calls[0]?.init?.cache, 'no-store');
});

test('일반 웹은 계정 세션 API를 호출하지 않는다', async () => {
    const fetcher = async () => {
        throw new Error('FETCH_MUST_NOT_RUN');
    };
    const api = createDashboardApi({fetcher, installedPwa: false});

    await assert.rejects(api.getAccountSession(), /ACCOUNT_AUTHENTICATION_UNAVAILABLE/u);
});

test('브라우저 계정 세션은 연결 상태 응답을 엄격히 검증한다', async () => {
    const expiresAt = '2026-08-14T10:00:00.000Z';
    const valid = createDashboardApi({
        fetcher: async () => jsonResponse({authenticated: true, expiresAt}),
    });
    assert.deepEqual(await valid.getAccountSession(), {authenticated: true, expiresAt});

    for (const value of [
        {authenticated: false, expiresAt},
        {authenticated: true, expiresAt: 'invalid'},
        {authenticated: true, expiresAt, userId: 'leak'},
    ]) {
        const invalid = createDashboardApi({fetcher: async () => jsonResponse(value)});
        await assert.rejects(invalid.getAccountSession(), /API_RESPONSE_INVALID/u);
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
                    expectedRefreshIntervalSeconds: 300,
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
                expectedRefreshIntervalSeconds: 300,
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
                quality: {
                    collection: 'SUCCESS',
                    sourceFreshness: 'REFRESH_OBSERVED',
                    lastCheckedAt: null,
                    expectedRefreshIntervalSeconds: 300,
                },
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

test('세탁 기기 최근 7일 위험 지표를 검증해 보존한다', async () => {
    const appliance = {
        appliance: 'washer',
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
        state: null,
        remainingMinutes: 0,
        startedAt: null,
        estimatedFinishAt: null,
        sessionId: null,
        errorCode: null,
        attempts: 6,
        errors: 1,
        rate: 100 / 6,
        riskLevel: 'slight',
    };
    const response = (value: unknown) => ({
        schemaVersion: 1,
        asOf: '2026-08-03T09:00:00.000Z',
        final: false,
        quality: {
            collection: 'SUCCESS',
            sourceFreshness: 'REFRESH_OBSERVED',
            lastCheckedAt: '2026-08-03T09:00:00.000Z',
            expectedRefreshIntervalSeconds: 300,
        },
        machines: [{id: '워시타워_1', washer: value, dryer: null}],
    });
    const valid = createDashboardApi({
        fetcher: async () => jsonResponse(response(appliance)),
    });

    assert.deepEqual((await valid.getPublicLaundry()).machines[0]?.washer, appliance);

    for (const invalidRisk of [
        {...appliance, errors: 7},
        {...appliance, rate: 16.6},
        {...appliance, riskLevel: 'safe'},
        {...appliance, attempts: -1},
    ]) {
        const invalid = createDashboardApi({
            fetcher: async () => jsonResponse(response(invalidRisk)),
        });
        await assert.rejects(invalid.getPublicLaundry(), /API_RESPONSE_INVALID/u);
    }
});

test('급식 원문 링크는 Kakao HTTPS allowlist만 화면 모델에 남긴다', async () => {
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({
            asOf: '2026-08-03T09:00:00.000Z',
            lastCheckedAt: '2026-08-03T09:00:00.000Z',
            data: {
                schemaVersion: 2,
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
                currentWeeklyMenu: null,
                weeklyMenus: [],
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

test('급식은 current schemaVersion 2와 주간·기록 필드를 모두 요구한다', async () => {
    const current = {
        asOf: '2026-08-11T09:00:00.000Z',
        lastCheckedAt: null,
        data: {
            schemaVersion: 2,
            dailyMenus: [],
            pinnedMenus: [],
            recentMenus: [],
            currentWeeklyMenu: null,
            weeklyMenus: [],
        },
    };
    const validApi = createDashboardApi({
        fetcher: async () => jsonResponse(current),
        invokeCommand: async () => undefined,
    });

    assert.deepEqual((await validApi.getPublicMeals()).data, current.data);

    const without = (field: keyof typeof current.data) => {
        const data: Partial<typeof current.data> = {...current.data};
        delete data[field];
        return {...current, data};
    };
    for (const invalid of [
        without('schemaVersion'),
        {...current, data: {...current.data, schemaVersion: 1}},
        without('currentWeeklyMenu'),
        without('weeklyMenus'),
        {...current, data: {...current.data, weeklyMenus: null}},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse(invalid),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getPublicMeals(), /API_RESPONSE_INVALID/);
    }
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
                schemaVersion: 2,
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
            },
        }),
        invokeCommand: async () => undefined,
    });

    const meals = await api.getPublicMeals();

    assert.equal(meals.data.dailyMenus[0]?.images?.[0]?.url,
        `https://campus.example.com/api/public/assets/${sha}.jpg`);
    assert.equal(meals.data.currentWeeklyMenu?.targetWeekKey, '2026-08-10');
    assert.equal(meals.data.weeklyMenus?.[0]?.post.id, 'meal-1');
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
                    schemaVersion: 2,
                    dailyMenus: [{
                        id: 'meal-1', title: '중식', text: '밥', publishedAt: null, permalink: null,
                        images: [image],
                    }],
                    pinnedMenus: [],
                    recentMenus: [],
                    currentWeeklyMenu: null,
                    weeklyMenus: [],
                },
            }),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getPublicMeals(), /API_RESPONSE_INVALID/);
    }
});

test('달력 월 이동은 해당 KST 월의 급식 기록만 공개 API로 요청한다', async () => {
    const calls: string[] = [];
    const api = createDashboardApi({
        campusApiBaseUrl: 'https://campus.example.com',
        fetcher: async (input) => {
            calls.push(String(input));
            return jsonResponse({posts: []});
        },
        invokeCommand: async () => undefined,
    });

    assert.deepEqual(await api.getPublicMealHistoryMonth('2026-07'), {
        posts: [],
    });
    assert.deepEqual(calls, [
        'https://campus.example.com/api/public/meals/history?month=2026-07',
    ]);
    await assert.rejects(api.getPublicMealHistoryMonth('2026-7'), /API_CLIENT_INVALID_ARGUMENT/);
    await assert.rejects(api.getPublicMealHistoryMonth('2026-13'), /API_CLIENT_INVALID_ARGUMENT/);
});

test('데스크톱 과거 급식 페이지도 인증 없는 공개 HTTP API를 사용한다', async () => {
    const urls: string[] = [];
    const commands: string[] = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        campusApiBaseUrl: 'https://campus.example.com',
        fetcher: async (input, init) => {
            urls.push(String(input));
            assert.equal(init?.credentials, 'omit');
            return jsonResponse({posts: []});
        },
        invokeCommand: async (command) => {
            commands.push(command);
            return undefined;
        },
    });

    await api.getPublicMealHistoryMonth('2026-07');

    assert.deepEqual(urls, ['https://campus.example.com/api/public/meals/history?month=2026-07']);
    assert.deepEqual(commands, []);
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
                    title: '학습 시작 체크가 필요합니다',
                    body: 'LMS에서 직접 확인해 주세요.',
                    path: '/#attendance',
                    createdAtEpochMs: 1_785_727_000_000,
                    expiresAtEpochMs: 1_785_727_600_000,
                    attempt: 1,
                }],
            });
        },
        invokeCommand: async () => undefined,
    });

    const notifications = await api.getNotifications();

    assert.equal(calls[0]?.url, 'https://platform.example.com/api/me/notifications?limit=20');
    assert.deepEqual(notifications, [{
        id: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe',
        kind: 'attendance-action-required',
        title: '학습 시작 체크가 필요합니다',
        body: 'LMS에서 직접 확인해 주세요.',
        path: '/#/attendance',
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
        {...base, path: '/#unknown'},
        {...base, path: '/#attendance', createdAtEpochMs: '2026-08-03T09:00:00.000Z'},
        {...base, path: '/#attendance', expiresAtEpochMs: undefined},
        {...base, path: '/#attendance', expiresAtEpochMs: Number.MAX_SAFE_INTEGER + 1},
    ]) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse({notifications: [notification]}),
            invokeCommand: async () => undefined,
        });
        await assert.rejects(api.getNotifications(), /API_RESPONSE_INVALID/);
    }
});

test('완료 예상 세탁 알림 종류를 알림함 응답으로 허용한다', async () => {
    const notification = {
        id: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe',
        kind: 'laundry-completion-expected',
        title: '세탁 완료 예상',
        body: '1번 세탁기의 예상 종료 시각입니다.',
        path: '/#/laundry',
        createdAtEpochMs: 1_785_727_000_000,
        expiresAtEpochMs: 1_785_727_600_000,
        attempt: 1,
    };
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({notifications: [notification]}),
        invokeCommand: async () => undefined,
    });

    assert.deepEqual(await api.getNotifications(), [notification]);
});

test('이전 출석 알림 종류를 현재 계약으로 정규화한다', async () => {
    const notification = (kind: 'attendance-morning' | 'attendance-evening', offset: number) => ({
        id: offset === 0
            ? '13fdbe73-d8d0-46a4-9fb5-85026f7162fe'
            : '23fdbe73-d8d0-46a4-9fb5-85026f7162fe',
        kind,
        title: '출석 확인',
        body: 'LMS에서 확인해 주세요.',
        path: '/#/attendance',
        createdAtEpochMs: 1_785_727_000_000 + offset,
        expiresAtEpochMs: 1_785_727_600_000 + offset,
        attempt: 0,
    });
    const api = createDashboardApi({
        fetcher: async () => jsonResponse({
            notifications: [
                notification('attendance-morning', 0),
                notification('attendance-evening', 1),
            ],
        }),
        invokeCommand: async () => undefined,
    });

    assert.deepEqual(
        (await api.getNotifications()).map(({kind}) => kind),
        ['attendance-action-required', 'attendance-action-required'],
    );
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

    await api.getAttendance();

    assert.equal(calls[0]?.url, 'https://platform.example.com/api/me/attendance');
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

    const result = await api.getAttendance();

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
        await assert.rejects(api.getAttendance(), /API_RESPONSE_INVALID/);
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

    await assert.rejects(api.getAttendance(), /API_RESPONSE_INVALID/);
});

test('데스크톱 서버 데이터는 단기 세션 HTTP, 네이티브 기능은 제한된 command를 쓴다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const requests: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            requests.push({url: String(input), init});
            return jsonResponse({attendance: null, freshness: 'missing', devices: []});
        },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            if (command === 'bootstrap_desktop_http_session') return desktopHttpSession();
            return {
                authenticated: true,
                credentialPersistent: true,
                identityResetRequired: false,
                lmsSessionState: 'connected',
                lastServerContact: '2026-08-03T09:00:00.000Z',
                lastError: null,
            };
        },
    });

    assert.equal((await api.getDesktopConnectionState()).credentialPersistent, true);
    await api.getAttendance();
    await api.refreshPlatformSync();

    assert.deepEqual(calls.map(({command}) => command), [
        'get_connected_service_status',
        'bootstrap_desktop_http_session',
        'refresh_platform_sync',
    ]);
    assert.equal(requests[0]?.url, 'https://platform.example.com/api/me/attendance');
    assert.equal(requests[0]?.init?.credentials, 'omit');
    assert.equal(
        new Headers(requests[0]?.init?.headers).get('authorization'),
        `Bearer ${desktopHttpSession().accessToken}`,
    );
});

test('데스크톱 credential 복구는 명시적 확인이 포함된 새 identity command만 사용한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            return {
                authenticated: true,
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

test('데스크톱 생활 정보도 공개 HTTP API를 직접 사용한다', async () => {
    const urls: string[] = [];
    const commands: string[] = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        campusApiBaseUrl: 'https://campus.example.com',
        fetcher: async (input) => {
            const url = String(input);
            urls.push(url);
            return jsonResponse(url.endsWith('/laundry')
                ? {
                    schemaVersion: 1,
                    asOf: '2026-08-03T09:00:00.000Z',
                    final: false,
                    quality: {
                        collection: 'SUCCESS',
                        sourceFreshness: 'REFRESH_OBSERVED',
                        lastCheckedAt: '2026-08-03T09:00:00.000Z',
                        expectedRefreshIntervalSeconds: 300,
                    },
                    machines: [],
                }
                : {
                    asOf: '2026-08-03T09:00:00.000Z',
                    lastCheckedAt: '2026-08-03T09:00:00.000Z',
                    data: {
                        schemaVersion: 2,
                        dailyMenus: [],
                        pinnedMenus: [],
                        recentMenus: [],
                        currentWeeklyMenu: null,
                        weeklyMenus: [],
                    },
                });
        },
        invokeCommand: async (command) => { commands.push(command); },
    });

    await api.getPublicLaundry();
    await api.getPublicMeals();

    assert.deepEqual(urls, [
        'https://campus.example.com/api/public/laundry',
        'https://campus.example.com/api/public/meals',
    ]);
    assert.deepEqual(commands, []);
});

test('데스크톱 페어링 상태는 서버의 expired 종료 상태를 허용한다', async () => {
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => jsonResponse({status: 'expired', claim: null}),
        invokeCommand: async (command) => {
            assert.equal(command, 'bootstrap_desktop_http_session');
            return desktopHttpSession();
        },
    });

    assert.deepEqual(
        await api.getMobilePairingStatus('jbp_01234567-89ab-4def-8123-456789abcdef'),
        {status: 'expired', claim: null},
    );
});

test('데스크톱 페어링 승인은 actual claimId를 strict desktop-ui body로 보낸다', async () => {
    const requests: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            requests.push({url: String(input), init});
            return new Response(null, {status: 204});
        },
        invokeCommand: async () => desktopHttpSession(),
    });
    const pairingId = 'jbp_01234567-89ab-4def-8123-456789abcdef';
    const claimId = 'jbp_11234567-89ab-4def-8123-456789abcdef';

    await api.approveMobilePairing(pairingId, claimId);

    assert.equal(
        requests[0]?.url,
        `https://platform.example.com/api/me/pairings/${pairingId}/approve`,
    );
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {claimId});
});

test('데스크톱 모바일 session 목록은 devices envelope와 빈 목록을 정상 처리한다', async () => {
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
        desktopRuntime: true,
        fetcher: async () => jsonResponse({devices: [device]}),
        invokeCommand: async () => desktopHttpSession(),
    });
    assert.deepEqual(await validApi.listMobileSessions(), [device]);

    const emptyApi = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => jsonResponse({devices: []}),
        invokeCommand: async () => desktopHttpSession(),
    });
    assert.deepEqual(await emptyApi.listMobileSessions(), []);

    for (const response of [
        [device],
        {sessions: [device]},
        {devices: [{...device, sessionId: device.deviceId}]},
    ]) {
        const api = createDashboardApi({
            desktopRuntime: true,
            fetcher: async () => jsonResponse(response),
            invokeCommand: async () => desktopHttpSession(),
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
            desktopRuntime: true,
            fetcher: async () => jsonResponse(status),
            invokeCommand: async () => desktopHttpSession(),
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
            desktopRuntime: true,
            fetcher: async () => jsonResponse({
                status: 'claimed',
                claim: {
                    claimId: 'jbp_01234567-89ab-4def-8123-456789abcdef',
                    deviceLabel: '모바일',
                    confirmationCode,
                },
            }),
            invokeCommand: async () => desktopHttpSession(),
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

test('데스크톱 알림함은 Tauri IPC snapshot을 검증하고 개별·전체 읽음 처리와 알림 활성화를 전달한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const snapshot = {
        revision: 2,
        unreadCount: 1,
        items: [{
            id: '42',
            title: '학습 시작을 확인해 주세요',
            body: '공식 정글캠퍼스에서 출석 상태를 확인하세요.',
            createdAt: 1_785_727_000_000,
            readAt: null,
            action: 'openAttendance',
        }],
    };
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            return snapshot;
        },
    });

    assert.deepEqual(await api.getDesktopNotificationInbox(), snapshot);
    assert.deepEqual(await api.markDesktopNotificationRead('42'), snapshot);
    assert.deepEqual(await api.markAllDesktopNotificationsRead(), snapshot);
    assert.deepEqual(await api.activateDesktopNotification('42'), snapshot);
    assert.deepEqual(calls, [
        {command: 'get_notification_inbox_snapshot', args: undefined},
        {command: 'mark_notification_read', args: {id: '42'}},
        {command: 'mark_all_notifications_read', args: undefined},
        {command: 'activate_notification', args: {id: '42'}},
    ]);
    await assert.rejects(api.markDesktopNotificationRead('../42'), /API_CLIENT_INVALID_ARGUMENT/);
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
        desktopRuntime: true,
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            fetches.push({url: String(input), init});
            return jsonResponse({notificationId: '13fdbe73-d8d0-46a4-9fb5-85026f7162fe', queued: 1}, 202);
        },
        invokeCommand: async (command, args) => {
            invokes.push({command, args});
            if (command === 'bootstrap_desktop_http_session') return desktopHttpSession();
            return {snapshot, systemDelivered: true, mobileQueued: 2};
        },
    });

    assert.deepEqual(await api.sendDesktopTestNotification(), {snapshot, systemDelivered: true, mobileQueued: 2});
    await api.sendMobileTestNotification();
    assert.deepEqual(invokes, [
        {command: 'send_test_notification', args: undefined},
        {command: 'bootstrap_desktop_http_session', args: undefined},
    ]);
    assert.equal(fetches[0]?.url, 'https://platform.example.com/api/me/notifications/test');
    assert.equal(fetches[0]?.init?.method, 'POST');
    assert.equal(fetches[0]?.init?.credentials, 'omit');
    assert.equal(
        new Headers(fetches[0]?.init?.headers).get('authorization'),
        `Bearer ${desktopHttpSession().accessToken}`,
    );
});

const mealPreferences = {
    enabled: true,
    lunch: true,
    dinner: true,
    updatedAtEpochMs: 1_785_727_000_000,
};

const attendancePreferences = {
    enabled: true,
    morning: true,
    evening: true,
    morningStartHour: 9,
    eveningEndHour: 4,
    morningIntervalMinutes: 15 as const,
    eveningIntervalMinutes: 15 as const,
    skipSunday: false,
    skipAttendanceDate: null,
};

const laundryWatch = {
    id: `jbw_${'a'.repeat(64)}`,
    machineId: '워시타워_1',
    appliance: 'washer' as const,
    sessionId: 'session-1',
    notificationMode: 'before-completion' as const,
    notifyBeforeMinutes: 10,
    status: 'active' as const,
    createdAtEpochMs: 1_785_727_000_000,
    updatedAtEpochMs: 1_785_727_000_001,
};

test('데스크톱 서비스 설정은 canonical current-only commands와 exact DTO를 사용한다', async () => {
    const calls: Array<{command: string; args?: Record<string, unknown>}> = [];
    const initial = {
        appVersion: '0.5.0-beta.1',
        autoStart: false,
        autoUpdate: true,
        usageAnalytics: true,
        debugMode: false,
        selectedCohortId: null,
        effectiveCohortId: 'cohort-1',
        cohortOptions: [{
            id: 'cohort-1', label: '정글 10기', startDate: '2026-07-01',
            endDate: '2026-08-31', isActive: true,
        }],
    };
    const updated = {...initial, autoStart: true};
    const api = createDashboardApi({
        desktopRuntime: true,
        fetcher: async () => { throw new Error('unexpected fetch'); },
        invokeCommand: async (command, args) => {
            calls.push({command, args});
            if (command === 'open_log_folder') return undefined;
            return command === 'update_desktop_settings' ? updated : initial;
        },
    });

    assert.deepEqual(await api.getDesktopSettings(), initial);
    assert.deepEqual(await api.updateDesktopSettings(updated), updated);
    await api.openLogFolder();
    assert.deepEqual(calls, [
        {command: 'get_desktop_settings', args: undefined},
        {command: 'update_desktop_settings', args: {input: {
            autoStart: true,
            autoUpdate: true,
            usageAnalytics: true,
            debugMode: false,
            selectedCohortId: null,
        }}},
        {command: 'open_log_folder', args: undefined},
    ]);
});

test('데스크톱 서비스 설정은 unknown field와 non-boolean을 거부한다', async () => {
    for (const response of [
        {
            appVersion: '0.5.0-beta.1',
            autoStart: false, autoUpdate: true, usageAnalytics: true, debugMode: false,
            selectedCohortId: null, effectiveCohortId: null, cohortOptions: [], unknown: true,
        },
        {
            appVersion: '0.5.0-beta.1',
            autoStart: 'true', autoUpdate: true, usageAnalytics: true, debugMode: false,
            selectedCohortId: null, effectiveCohortId: null, cohortOptions: [],
        },
        {
            appVersion: '0.5.0-beta.1',
            autoStart: false, autoUpdate: true, usageAnalytics: true, debugMode: false,
            selectedCohortId: '\nforged', effectiveCohortId: null, cohortOptions: [],
        },
        {
            appVersion: 'beta',
            autoStart: false, autoUpdate: true, usageAnalytics: true, debugMode: false,
            selectedCohortId: null, effectiveCohortId: null, cohortOptions: [],
        },
    ]) {
        const api = createDashboardApi({
            desktopRuntime: true,
            fetcher: async () => { throw new Error('unexpected fetch'); },
            invokeCommand: async () => response,
        });
        await assert.rejects(api.getDesktopSettings(), /API_RESPONSE_INVALID/);
    }
});

test('데스크톱 개인 생활 설정은 desktop-ui HTTP namespace와 단기 bearer만 사용한다', async () => {
    const commands: string[] = [];
    const requests: Array<{url: string; init?: RequestInit}> = [];
    const api = createDashboardApi({
        desktopRuntime: true,
        platformApiBaseUrl: 'https://platform.example.com',
        fetcher: async (input, init) => {
            const url = String(input);
            requests.push({url, init});
            if (init?.method === 'DELETE') return new Response(null, {status: 204});
            if (url.endsWith('/attendance/preferences')) return jsonResponse(attendancePreferences);
            if (url.endsWith('/meal-preferences')) return jsonResponse(mealPreferences);
            if (url.endsWith('/laundry-watches') && init?.method === 'GET') {
                return jsonResponse({watches: [laundryWatch]});
            }
            if (url.endsWith('/laundry-watches')) return jsonResponse(laundryWatch, 201);
            throw new Error(`unexpected URL: ${url}`);
        },
        invokeCommand: async (command) => {
            commands.push(command);
            return desktopHttpSession();
        },
    });

    assert.deepEqual(await api.getAttendancePreferences(), attendancePreferences);
    assert.deepEqual(await api.updateAttendancePreferences({
        ...attendancePreferences, morning: false, skipSunday: true, skipAttendanceDate: '2026-08-10',
    }), attendancePreferences);
    assert.deepEqual(await api.getMealPreferences(), mealPreferences);
    assert.deepEqual(await api.updateMealPreferences({
        enabled: true, lunch: true, dinner: true,
    }), mealPreferences);
    assert.deepEqual(await api.listLaundryWatches(), [laundryWatch]);
    assert.deepEqual(await api.createLaundryWatch({
        machineId: '워시타워_1', appliance: 'washer', sessionId: 'session-1',
        notificationMode: 'before-completion', notifyBeforeMinutes: 10,
    }), laundryWatch);
    await api.deleteLaundryWatch(laundryWatch.id);
    assert.deepEqual(commands, ['bootstrap_desktop_http_session']);
    assert.deepEqual(requests.map(({url}) => new URL(url).pathname), [
        '/api/me/attendance/preferences',
        '/api/me/attendance/preferences',
        '/api/me/meal-preferences',
        '/api/me/meal-preferences',
        '/api/me/laundry-watches',
        '/api/me/laundry-watches',
        `/api/me/laundry-watches/${laundryWatch.id}`,
    ]);
    assert.deepEqual(JSON.parse(String(requests[5]?.init?.body)), {
        machineId: '워시타워_1',
        appliance: 'washer',
        sessionId: 'session-1',
        notificationMode: 'before-completion',
        notifyBeforeMinutes: 10,
    });
    for (const {init} of requests) {
        assert.equal(init?.credentials, 'omit');
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${desktopHttpSession().accessToken}`);
    }
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
            throw new Error(`unexpected URL: ${url}`);
        },
        invokeCommand: async () => { throw new Error('unexpected invoke'); },
    });

    await api.getAttendancePreferences();
    await api.updateAttendancePreferences({
        ...attendancePreferences, evening: false, skipSunday: true,
    });
    await api.getMealPreferences();
    await api.updateMealPreferences({
        enabled: false, lunch: true, dinner: false,
    });
    await api.listLaundryWatches();
    await api.createLaundryWatch({
        machineId: '워시타워_1', appliance: 'washer', sessionId: 'session-1',
        notificationMode: 'confirmed-completion', notifyBeforeMinutes: 0,
    });
    await api.deleteLaundryWatch(laundryWatch.id);
    assert.deepEqual(JSON.parse(String(calls[5]?.init?.body)), {
        machineId: '워시타워_1',
        appliance: 'washer',
        sessionId: 'session-1',
        notificationMode: 'confirmed-completion',
        notifyBeforeMinutes: 0,
    });
    assert.deepEqual(calls.map(({url, init}) => ({
        path: new URL(url).pathname,
        method: init?.method,
        credentials: init?.credentials,
        cache: init?.cache,
        authorization: new Headers(init?.headers).has('authorization'),
        accept: new Headers(init?.headers).get('accept'),
        contentType: new Headers(init?.headers).get('content-type'),
    })), [
        {path: '/api/me/attendance/preferences', method: 'GET', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: null},
        {path: '/api/me/attendance/preferences', method: 'PUT', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: 'application/json'},
        {path: '/api/me/meal-preferences', method: 'GET', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: null},
        {path: '/api/me/meal-preferences', method: 'PUT', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: 'application/json'},
        {path: '/api/me/laundry-watches', method: 'GET', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: null},
        {path: '/api/me/laundry-watches', method: 'POST', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: 'application/json'},
        {path: `/api/me/laundry-watches/${laundryWatch.id}`, method: 'DELETE', credentials: 'include', cache: 'no-store', authorization: false, accept: 'application/json', contentType: null},
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
        ...attendancePreferences, evening: false, skipSunday: true,
    });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
        enabled: false, lunch: true, dinner: false,
    });
});

test('개인 생활 설정 DTO는 unknown field와 깨진 상태 불변식을 거부한다', async () => {
    const invalidResponses = [
        {...attendancePreferences, skipAttendanceDate: '2026-02-30'},
        {...mealPreferences, legacyAlias: true},
        {watches: [{...laundryWatch, id: 'watch-1'}]},
        {watches: [{...laundryWatch, updatedAtEpochMs: laundryWatch.createdAtEpochMs - 1}]},
    ];
    const operations = ['attendance', 'meal', 'watches', 'watches'] as const;
    for (let index = 0; index < invalidResponses.length; index += 1) {
        const api = createDashboardApi({
            fetcher: async () => jsonResponse(invalidResponses[index]),
            invokeCommand: async () => undefined,
        });
        const operation = operations[index];
        await assert.rejects(
            operation === 'attendance'
                ? api.getAttendancePreferences()
                : operation === 'meal'
                ? api.getMealPreferences()
                : api.listLaundryWatches(),
            /API_RESPONSE_INVALID/,
        );
    }
});

test('개인 생활 설정 API는 손상된 JSON 응답을 안정된 오류 코드로 변환한다', async () => {
    const api = createDashboardApi({
        fetcher: async () => new Response('{', {
            status: 200,
            headers: {'content-type': 'application/json'},
        }),
        invokeCommand: async () => undefined,
    });

    await assert.rejects(
        api.getMealPreferences(),
        /API_RESPONSE_INVALID/,
    );
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
