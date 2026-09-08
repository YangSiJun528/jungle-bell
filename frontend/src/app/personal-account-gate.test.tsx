import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {createMemoryHistory, RouterContextProvider} from '@tanstack/react-router';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {createDashboardRouter} from './dashboard-router';
import {PersonalAccountGate} from './personal-account-gate';

const {account, environment} = vi.hoisted(() => ({
    account: {
        personalAccess: 'unconnected',
        personalReason: 'first-connect',
        lmsAuthentication: 'not-applicable',
        serverSession: 'not-applicable',
        browserSessionRefetch: vi.fn<() => void>(),
    },
    environment: {
        authentication: 'none',
        platformKind: 'browser',
    },
}));

vi.mock('./dashboard-account', () => ({
    useDashboardAccount: () => ({
        personalAccess: {status: account.personalAccess, reason: account.personalReason},
        status: {
            lmsAuthentication: account.lmsAuthentication,
            serverSession: account.serverSession,
        },
        connectionQuery: {refetch: vi.fn<() => void>()},
        browserSessionQuery: {refetch: account.browserSessionRefetch},
    }),
}));

vi.mock('./dashboard-context', () => ({
    useDashboardEnvironment: () => ({
        api: {openLmsLogin: vi.fn<() => Promise<void>>()},
        platform: {
            kind: environment.platformKind,
            capabilities: {desktopAccount: environment.platformKind === 'desktop'},
            accountAuthentication: {kind: environment.authentication},
            pwa: {installed: false},
        },
    }),
}));

vi.mock('./use-dashboard-queries', () => ({
    useRefreshAttendanceMutation: () => ({isPending: false, mutate: vi.fn<() => void>()}),
}));

function renderGate(
    status: string,
    options: {
        authentication?: string;
        personalReason?: string;
        platformKind?: string;
        lmsAuthentication?: string;
        serverSession?: string;
    } = {},
): string {
    account.personalAccess = status;
    account.personalReason = options.personalReason ?? 'first-connect';
    account.lmsAuthentication = options.lmsAuthentication ?? 'not-applicable';
    account.serverSession = options.serverSession ?? 'not-applicable';
    environment.platformKind = options.platformKind ?? 'browser';
    environment.authentication =
        options.authentication ??
        (environment.platformKind === 'desktop' ? 'desktop-session' : 'none');
    const client = new QueryClient();
    const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/connections']}));
    return renderToStaticMarkup(
        <RouterContextProvider router={router}>
            <QueryClientProvider client={client}>
                <PersonalAccountGate>
                    <p>개인 설정</p>
                </PersonalAccountGate>
            </QueryClientProvider>
        </RouterContextProvider>,
    );
}

describe('PersonalAccountGate browser policy', () => {
    test('일반 Web의 독립 개인 화면은 앱 설치 안내로 이동한다', () => {
        const markup = renderGate('unconnected');

        expect(markup).toContain('앱 설치가 필요합니다.');
        expect(markup).toContain('href="/install"');
        expect(markup).toContain('href="/home"');
        expect(markup).not.toContain('개인 설정');
    });

    test('연결된 PWA에서만 개인 화면 내용을 렌더링한다', () => {
        expect(
            renderGate('connected', {
                authentication: 'cookie',
                personalReason: 'authenticated',
            }),
        ).toContain('개인 설정');
        expect(
            renderGate('checking', {
                authentication: 'cookie',
                personalReason: 'initial-check',
            }),
        ).toContain('PC 연결 상태를 확인하고 있습니다.');
        expect(
            renderGate('error', {
                authentication: 'cookie',
                personalReason: 'server-error',
            }),
        ).toContain('서버 오류로 PC 연결을 확인하지 못했습니다.');
        expect(
            renderGate('unconnected', {
                authentication: 'cookie',
                personalReason: 'first-connect',
            }),
        ).toContain('href="/connections?tab=devices"');
    });

    test('PC 개인 설정은 동일한 인증·복구 게이트 정책을 사용한다', () => {
        const markup = renderGate('unconnected', {
            platformKind: 'desktop',
            lmsAuthentication: 'required',
            serverSession: 'missing',
        });

        expect(markup).toContain('LMS 로그인이 필요합니다.');
        expect(markup).toContain('LMS 로그인 창 열기');
        expect(markup).toContain('href="/home"');
        expect(markup).not.toContain('개인 설정');
    });
});
