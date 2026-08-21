import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {PlatformAuthenticationGate} from './platform-authentication-gate';

const {account, environment} = vi.hoisted(() => ({
    account: {
        personalAccess: 'unconnected',
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
        personalAccess: {status: account.personalAccess},
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
        },
    }),
}));

function renderGate(options: {
    authentication: string;
    personalAccess?: string;
    lmsAuthentication?: string;
    serverSession?: string;
    desktopAccount?: boolean;
}): string {
    environment.authentication = options.authentication;
    environment.desktopAccount = options.desktopAccount ?? false;
    account.personalAccess = options.personalAccess ?? 'not-applicable';
    account.lmsAuthentication = options.lmsAuthentication ?? 'not-applicable';
    account.serverSession = options.serverSession ?? 'not-applicable';
    routeRenderCount = 0;
    return renderToStaticMarkup(
        <PlatformAuthenticationGate
            connectionContent={<p>기기 연결 화면</p>}
            notice={<p data-update-notice="true">업데이트 안내</p>}
        >
            <RouteContent />
        </PlatformAuthenticationGate>,
    );
}

let routeRenderCount = 0;

function RouteContent() {
    routeRenderCount += 1;
    return <p data-route-content="true">대시보드</p>;
}

describe('PlatformAuthenticationGate', () => {
    test('일반 웹은 인증 상태와 무관하게 공개 대시보드를 연다', () => {
        expect(renderGate({authentication: 'none'})).toContain('대시보드');
        expect(routeRenderCount).toBe(1);
    });

    test('PWA의 정착된 세션 상태에 따라 전체 화면을 분기한다', () => {
        expect(renderGate({authentication: 'cookie', personalAccess: 'connected'})).toContain(
            '대시보드',
        );

        const checking = renderGate({authentication: 'cookie', personalAccess: 'checking'});
        expect(checking).toContain('PC 연결 상태를 확인하고 있습니다.');
        expect(checking).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);

        const error = renderGate({authentication: 'cookie', personalAccess: 'error'});
        expect(error).toContain('PC 연결 상태를 확인하지 못했습니다.');
        expect(error).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);

        const unconnected = renderGate({authentication: 'cookie', personalAccess: 'unconnected'});
        expect(unconnected).toContain('PC 앱 연결이 필요합니다.');
        expect(unconnected).toContain('기기 연결 화면');
        expect(unconnected).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
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
        expect(markup).toContain('data-update-notice="true"');
        expect(markup).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
        expect(markup.includes('상태 다시 확인')).toBe(lmsAuthentication === 'unavailable');
    });

    test.each(['missing', 'unavailable', 'recovery-required'])(
        'PC의 LMS 인증이 확인되면 서버 세션이 %s여도 대시보드를 연다',
        (serverSession) => {
            const markup = renderGate({
                authentication: 'desktop-session',
                desktopAccount: true,
                lmsAuthentication: 'authenticated',
                serverSession,
            });

            expect(markup).toContain('대시보드');
            expect(markup).not.toContain('data-authentication-gate');
            expect(routeRenderCount).toBe(1);
        },
    );
});
