import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import type {DashboardLaundrySnapshot, LaundryWatch} from '@/api/dashboard-api';
import {PersonalLaundrySection} from './personal-laundry-section';

const {api, queryKeys, state} = vi.hoisted(() => ({
    queryKeys: {
        laundryWatches: ['personal', 'laundry-watches'] as const,
    },
    api: {
        listLaundryWatches: vi.fn(),
        createLaundryWatch: vi.fn(),
        deleteLaundryWatch: vi.fn(),
        openLmsLogin: vi.fn(),
    },
    state: {
        lmsAuthentication: 'authenticated',
        attendanceStatus: 'available',
        personalAccess: 'connected',
        platformKind: 'desktop',
        serverSession: 'stored',
    },
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => ({
        api,
        platform: {
            kind: state.platformKind,
            capabilities: {desktopAccount: state.platformKind === 'desktop'},
        },
    }),
}));

vi.mock('@/app/dashboard-account', () => ({
    useDashboardAccount: () => ({
        status: {
            serverSession: state.serverSession,
            lmsAuthentication: state.lmsAuthentication,
        },
        personalAccess: {status: state.personalAccess},
        connectionQuery: {refetch: vi.fn()},
        browserSessionQuery: {refetch: vi.fn()},
    }),
}));

vi.mock('@/app/dashboard-account-state', () => ({
    assertLmsAuthenticated: () => {
        if (state.lmsAuthentication !== 'authenticated') throw new Error('LMS_AUTH_REQUIRED');
    },
    assertServerSessionReady: () => {
        if (state.serverSession !== 'stored' && state.serverSession !== 'memory-only') {
            throw new Error('SERVER_SESSION_REQUIRED');
        }
    },
    serverSessionReady: () => state.serverSession === 'stored' || state.serverSession === 'memory-only',
}));

vi.mock('@/app/use-dashboard-queries', () => ({
    useAttendanceQuery: () => ({
        data: {
            state: 'loaded',
            attendance: state.attendanceStatus === 'available'
                ? {
                    status: 'available',
                    freshness: 'fresh',
                    lastSyncedAt: '2026-08-12T00:00:00.000Z',
                    snapshot: {},
                }
                : {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null},
            devices: [],
        },
        isPending: false,
        isError: false,
        refetch: vi.fn(),
    }),
    useRefreshAttendanceMutation: () => ({isPending: false, mutate: vi.fn()}),
}));

const machines: DashboardLaundrySnapshot['machines'] = [{
    id: '워시타워_1',
    zone: 'men',
    washer: {
        appliance: 'washer',
        operationalStatus: 'RUNNING',
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 23},
    },
    dryer: {
        appliance: 'dryer',
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    },
}];

const activeWatch: LaundryWatch = {
    id: 'watch-1',
    machineId: '워시타워_1',
    appliance: 'washer',
    sessionId: 'washer-session',
    notifyBeforeMinutes: 10,
    notifyWhenAvailable: true,
    status: 'active',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
};

function renderPersonalLaundry(options: {
    watches?: LaundryWatch[];
    machines?: DashboardLaundrySnapshot['machines'];
    lmsAuthentication?: string;
    personalAccess?: string;
    platformKind?: string;
    attendanceStatus?: string;
    serverSession?: string;
} = {}): string {
    const client = new QueryClient();
    state.lmsAuthentication = options.lmsAuthentication ?? 'authenticated';
    state.attendanceStatus = options.attendanceStatus ?? 'available';
    state.serverSession = options.serverSession ?? 'stored';
    state.platformKind = options.platformKind ?? 'desktop';
    state.personalAccess = options.personalAccess
        ?? (state.lmsAuthentication === 'authenticated'
            && (state.serverSession === 'stored' || state.serverSession === 'memory-only')
            ? 'connected'
            : 'unconnected');
    client.setQueryData(queryKeys.laundryWatches, options.watches ?? [activeWatch]);

    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <PersonalLaundrySection
                machines={options.machines ?? machines}
            />
        </QueryClientProvider>,
    );
}

describe('PersonalLaundrySection', () => {
    test('출석 계정이 준비되면 개인 세탁 알림만 표시한다', () => {
        const markup = renderPersonalLaundry();

        expect(markup).toContain('aria-label="개인 세탁 기능"');
        expect(markup).toContain('내 세탁 알림');
        expect(markup).toContain('1번 · 세탁기');
        expect(markup).toContain('이 동작 종료 10분 전·완료·사용 가능 전환 알림');
    });

    test('기기 상태가 없어도 개인 제어의 빈 상태를 안전하게 표시한다', () => {
        const markup = renderPersonalLaundry({watches: [], machines: []});

        expect(markup).toContain('기기 상태가 확인되면 알림 대상을 선택할 수 있습니다.');
        expect(markup).toContain('설정된 세탁 알림이 없습니다.');
    });

    test('LMS 인증 전에는 개인 세탁 영역을 표시하지 않는다', () => {
        const markup = renderPersonalLaundry({lmsAuthentication: 'required'});

        expect(markup).toBe('');
    });

    test('미연결 웹에서는 개인 세탁 UI와 query subtree를 렌더링하지 않는다', () => {
        api.listLaundryWatches.mockClear();
        const markup = renderPersonalLaundry({
            platformKind: 'browser',
            personalAccess: 'unconnected',
            watches: [],
        });

        expect(markup).toBe('');
        expect(api.listLaundryWatches).not.toHaveBeenCalled();
    });

    test('출석 snapshot이 없으면 개인 세탁 요청 전에 동기화를 안내한다', () => {
        const markup = renderPersonalLaundry({attendanceStatus: 'unavailable'});

        expect(markup).toContain('출석 동기화가 필요합니다.');
        expect(markup).toContain('새로고침');
        expect(markup).not.toContain('내 세탁 알림');
    });

    test('서버 credential이 없으면 화면에 끼워진 개인 영역을 숨긴다', () => {
        const markup = renderPersonalLaundry({serverSession: 'missing'});

        expect(markup).toBe('');
    });

    test('알림 대상 선택 영역은 카드 폭 안에서 줄어들고 버튼은 침범하지 않는다', () => {
        const markup = renderPersonalLaundry();
        const controls = markup.match(/<div[^>]*data-laundry-watch-controls="true"[^>]*>/u)?.[0];
        const addButton = markup.match(/<button[^>]*data-laundry-watch-add="true"[^>]*>/u)?.[0];

        expect(controls).toContain('min-w-0');
        expect(markup).toMatch(/data-slot="select-trigger"[^>]*class="[^"]*min-w-0/u);
        expect(addButton).toContain('shrink-0');
        expect(markup).toMatch(/data-slot="card"[^>]*class="[^"]*min-w-0/u);
    });
});
