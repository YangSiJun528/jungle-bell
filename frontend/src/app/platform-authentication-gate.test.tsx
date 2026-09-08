import {createMemoryHistory, RouterContextProvider} from '@tanstack/react-router';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {
    browserSessionObservation,
    checkerWaitTransition,
    initialCheckerWaitState,
    transitionCookieSessionAccess,
} from './dashboard-account-state';
import {createDashboardRouter} from './dashboard-router';
import {PlatformAuthenticationGate} from './platform-authentication-gate';

const {account, environment} = vi.hoisted(() => ({
    account: {
        personalAccess: 'unconnected',
        personalReason: 'first-connect',
        lmsAuthentication: 'not-applicable',
        serverSession: 'not-applicable',
        browserFetching: false,
        connectionFetching: false,
        refetchBrowser: vi.fn<() => Promise<unknown>>(),
        refetchConnection: vi.fn<() => Promise<unknown>>(),
    },
    environment: {
        authentication: 'none',
        desktopAccount: false,
        pwaInstalled: false,
        openLmsLogin: vi.fn<() => Promise<void>>(),
    },
}));

vi.mock('@tanstack/react-query', () => ({
    useMutation: ({mutationFn}: {mutationFn: () => Promise<unknown>}) => ({
        isPending: false,
        isError: false,
        mutate: () => void mutationFn(),
    }),
}));

vi.mock('./dashboard-account', () => ({
    useDashboardAccount: () => ({
        personalAccess: {status: account.personalAccess, reason: account.personalReason},
        status: {
            lmsAuthentication: account.lmsAuthentication,
            serverSession: account.serverSession,
        },
        browserSessionQuery: {
            isFetching: account.browserFetching,
            refetch: account.refetchBrowser,
        },
        connectionQuery: {
            isFetching: account.connectionFetching,
            refetch: account.refetchConnection,
        },
    }),
}));

vi.mock('./dashboard-context', () => ({
    useDashboardEnvironment: () => ({
        api: {openLmsLogin: environment.openLmsLogin},
        platform: {
            capabilities: {desktopAccount: environment.desktopAccount},
            accountAuthentication: {kind: environment.authentication},
            pwa: {installed: environment.pwaInstalled},
        },
    }),
}));

vi.mock('./use-dashboard-queries', () => ({
    useRefreshAttendanceMutation: () => ({isPending: false, mutate: vi.fn<() => void>()}),
}));

function renderGate(options: {
    authentication: string;
    personalAccess?: string;
    personalReason?: string;
    lmsAuthentication?: string;
    serverSession?: string;
    desktopAccount?: boolean;
    enabled?: boolean;
    preserveRouteHeading?: boolean;
    pwaInstalled?: boolean;
}): string {
    environment.authentication = options.authentication;
    environment.desktopAccount = options.desktopAccount ?? false;
    environment.pwaInstalled = options.pwaInstalled ?? false;
    account.personalAccess = options.personalAccess ?? 'not-applicable';
    account.personalReason = options.personalReason ?? 'not-applicable';
    account.lmsAuthentication = options.lmsAuthentication ?? 'not-applicable';
    account.serverSession = options.serverSession ?? 'not-applicable';
    routeRenderCount = 0;
    const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/attendance']}));
    return renderToStaticMarkup(
        <RouterContextProvider router={router}>
            <PlatformAuthenticationGate
                enabled={options.enabled}
                preserveRouteHeading={options.preserveRouteHeading}
                timeoutMilliseconds={10_000}
            >
                <RouteContent />
            </PlatformAuthenticationGate>
        </RouterContextProvider>,
    );
}

let routeRenderCount = 0;

function RouteContent() {
    routeRenderCount += 1;
    return <p data-route-content="true">대시보드</p>;
}

describe('PlatformAuthenticationGate', () => {
    test.each([
        ['Web', {authentication: 'none', personalAccess: 'not-applicable'}],
        [
            'PWA offline',
            {
                authentication: 'cookie',
                personalAccess: 'error',
                personalReason: 'offline',
            },
        ],
        [
            'PC expired',
            {
                authentication: 'desktop-session',
                desktopAccount: true,
                personalAccess: 'unconnected',
                personalReason: 'expired',
                lmsAuthentication: 'required',
                serverSession: 'stored',
            },
        ],
    ] as const)('%s에서도 공개 route는 인증 gate를 통과한다', (_label, options) => {
        const markup = renderGate({...options, enabled: false});

        expect(markup).toContain('data-route-content');
        expect(markup).not.toContain('data-personal-access-gate');
        expect(routeRenderCount).toBe(1);
    });

    test('일반 Web의 개인 기능은 설치 행동과 공개 홈 복귀를 제공한다', () => {
        const markup = renderGate({authentication: 'none'});

        expect(markup).toContain('앱 설치가 필요합니다.');
        expect(markup).toContain('href="/install"');
        expect(markup).toContain('href="/home"');
        expect(markup).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
    });

    test('route 본문의 개인 기능 gate는 현재 화면 H1을 유지한다', () => {
        const markup = renderGate({authentication: 'none', preserveRouteHeading: true});

        expect(markup).toContain('data-personal-access-route-frame="true"');
        expect(markup).toContain('<h1');
        expect(markup).toContain('출석</h1>');
        expect(markup).toContain('앱 설치가 필요합니다.');
    });

    test('PWA의 개인 기능만 연결 상태에 따라 인라인으로 분기한다', () => {
        expect(
            renderGate({
                authentication: 'cookie',
                personalAccess: 'connected',
                personalReason: 'authenticated',
            }),
        ).toContain('대시보드');

        const checking = renderGate({
            authentication: 'cookie',
            personalAccess: 'checking',
            personalReason: 'initial-check',
        });
        expect(checking).toContain('PC 연결 상태를 확인하고 있습니다.');
        expect(checking).toContain('tab=devices');
        expect(checking).toContain('returnTo=%2Fattendance');
        expect(checking).toContain('href="/home"');
        expect(checking).not.toContain('min-h-svh');
        expect(checking).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);

        const offline = renderGate({
            authentication: 'cookie',
            personalAccess: 'error',
            personalReason: 'offline',
        });
        expect(offline).toContain('오프라인이라 PC 연결을 확인할 수 없습니다.');
        expect(offline).toContain('인터넷 연결을 확인한 뒤 다시 시도하세요.');
        expect(offline).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);

        const serverError = renderGate({
            authentication: 'cookie',
            personalAccess: 'error',
            personalReason: 'server-error',
        });
        expect(serverError).toContain('서버 오류로 PC 연결을 확인하지 못했습니다.');

        const firstConnect = renderGate({
            authentication: 'cookie',
            personalAccess: 'unconnected',
            personalReason: 'first-connect',
        });
        expect(firstConnect).toContain('PC 앱 최초 연결이 필요합니다.');
        expect(firstConnect).toContain('tab=devices');
        expect(firstConnect).not.toContain('data-route-content');

        const expired = renderGate({
            authentication: 'cookie',
            personalAccess: 'unconnected',
            personalReason: 'expired',
        });
        expect(expired).toContain('PC 연결 세션이 만료되었습니다.');
        expect(expired).toContain('원래 경로로 돌아올 수 있습니다.');
        expect(expired).toContain('returnTo=%2Fattendance');
        expect(routeRenderCount).toBe(0);
    });

    test('provider의 authenticated 후 만료·offline·server-error 전이를 gate가 구분한다', () => {
        const session = {authenticated: true as const, expiresAt: '2026-09-10T00:00:00.000Z'};
        const connected = transitionCookieSessionAccess(
            null,
            browserSessionObservation({
                data: session,
                isPending: false,
                isError: false,
                fetchStatus: 'idle',
            }),
            Date.parse('2026-09-08T00:00:00.000Z'),
        );
        const transitions = [
            transitionCookieSessionAccess(
                connected.evidence,
                browserSessionObservation({
                    data: null,
                    isPending: false,
                    isError: false,
                    fetchStatus: 'idle',
                }),
                Date.parse('2026-09-10T00:00:00.000Z'),
            ),
            transitionCookieSessionAccess(
                connected.evidence,
                browserSessionObservation({
                    data: session,
                    isPending: false,
                    isError: false,
                    fetchStatus: 'paused',
                }),
                Date.parse('2026-09-08T01:00:00.000Z'),
            ),
            transitionCookieSessionAccess(
                connected.evidence,
                browserSessionObservation({
                    data: session,
                    isPending: false,
                    isError: true,
                    fetchStatus: 'idle',
                }),
                Date.parse('2026-09-08T01:00:00.000Z'),
            ),
        ];
        const expectedTitles = [
            'PC 연결 세션이 만료되었습니다.',
            '오프라인이라 PC 연결을 확인할 수 없습니다.',
            '서버 오류로 PC 연결을 확인하지 못했습니다.',
        ];

        transitions.forEach((transition, index) => {
            const markup = renderGate({
                authentication: 'cookie',
                personalAccess: transition.state.status,
                personalReason: transition.state.reason,
            });
            expect(markup).toContain(expectedTitles[index]);
            expect(markup).not.toContain('data-route-content');
        });
    });

    test.each([
        ['checking', 'LMS 로그인 상태를 확인하고 있습니다.'],
        ['required', 'LMS 로그인이 필요합니다.'],
        ['unavailable', 'LMS 로그인 상태를 확인하지 못했습니다.'],
    ])('PC의 %s 상태는 라우트를 차단하고 LMS 창 열기를 제공한다', (lmsAuthentication, message) => {
        const markup = renderGate({
            authentication: 'desktop-session',
            desktopAccount: true,
            lmsAuthentication,
            serverSession: 'missing',
        });

        expect(markup).toContain(message);
        expect(markup).toContain('LMS 로그인 창 열기');
        expect(markup).toContain('href="/home"');
        expect(markup).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
        expect(markup.includes('상태 다시 확인')).toBe(lmsAuthentication === 'unavailable');
    });

    test('PC 계정 복구 상태는 복구 위치와 공개 홈을 제공하고 children을 mount하지 않는다', () => {
        const markup = renderGate({
            authentication: 'desktop-session',
            desktopAccount: true,
            personalAccess: 'unconnected',
            lmsAuthentication: 'authenticated',
            serverSession: 'recovery-required',
        });

        expect(markup).toContain('계정 복구가 필요합니다.');
        expect(markup).toContain('tab=devices');
        expect(markup).toContain('returnTo=%2Fattendance');
        expect(markup).toContain('href="/home"');
        expect(routeRenderCount).toBe(0);
    });

    test('connected 상태는 같은 route의 children을 렌더링한다', () => {
        const markup = renderGate({
            authentication: 'desktop-session',
            desktopAccount: true,
            personalAccess: 'connected',
            lmsAuthentication: 'authenticated',
            serverSession: 'stored',
        });

        expect(markup).toContain('대시보드');
        expect(markup).not.toContain('data-personal-access-gate');
        expect(routeRenderCount).toBe(1);
    });
});

describe('checkerWaitTransition', () => {
    test('현재 시도의 timeout만 오류로 전환한다', () => {
        const waiting = initialCheckerWaitState;

        expect(checkerWaitTransition(waiting, {type: 'timeout', attempt: 1})).toBe(waiting);
        expect(checkerWaitTransition(waiting, {type: 'timeout', attempt: 0})).toEqual({
            attempt: 0,
            timedOut: true,
        });
    });

    test('retry는 timeout을 지우고 이전 timer 전이를 무시한다', () => {
        const timedOut = checkerWaitTransition(initialCheckerWaitState, {
            type: 'timeout',
            attempt: 0,
        });
        const retried = checkerWaitTransition(timedOut, {type: 'retry'});

        expect(retried).toEqual({attempt: 1, timedOut: false});
        expect(checkerWaitTransition(retried, {type: 'timeout', attempt: 0})).toBe(retried);
        expect(checkerWaitTransition(retried, {type: 'timeout', attempt: 1})).toEqual({
            attempt: 1,
            timedOut: true,
        });
    });

    test('checker가 결정되면 timeout 상태를 해제한다', () => {
        const timedOut = {attempt: 2, timedOut: true};
        expect(checkerWaitTransition(timedOut, {type: 'resolved'})).toEqual({
            attempt: 2,
            timedOut: false,
        });
    });
});
