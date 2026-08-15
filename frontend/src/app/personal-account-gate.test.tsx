import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {createMemoryHistory, RouterContextProvider} from '@tanstack/react-router';
import {describe, expect, test, vi} from 'vitest';
import {PersonalAccountGate} from './personal-account-gate';
import {createDashboardRouter} from './dashboard-router';

const {account, environment} = vi.hoisted(() => ({
    account: {
        personalAccess: 'unconnected',
        browserSessionRefetch: vi.fn(),
    },
    environment: {
        platformKind: 'browser',
    },
}));

vi.mock('./dashboard-account', () => ({
    useDashboardAccount: () => ({
        personalAccess: {status: account.personalAccess},
        status: {lmsAuthentication: 'not-applicable', serverSession: 'not-applicable'},
        connectionQuery: {refetch: vi.fn()},
        browserSessionQuery: {refetch: account.browserSessionRefetch},
    }),
}));

vi.mock('./dashboard-context', () => ({
    useDashboardEnvironment: () => ({
        api: {openLmsLogin: vi.fn()},
        platform: {
            kind: environment.platformKind,
            capabilities: {desktopAccount: environment.platformKind === 'desktop'},
        },
    }),
}));

vi.mock('./use-dashboard-queries', () => ({
    useRefreshAttendanceMutation: () => ({isPending: false, mutate: vi.fn()}),
}));

function renderGate(status: string): string {
    account.personalAccess = status;
    const client = new QueryClient();
    const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/connections']}));
    return renderToStaticMarkup(
        <RouterContextProvider router={router}>
            <QueryClientProvider client={client}>
                <PersonalAccountGate><p>개인 설정</p></PersonalAccountGate>
            </QueryClientProvider>
        </RouterContextProvider>,
    );
}

describe('PersonalAccountGate browser policy', () => {
    test('미연결 웹의 독립 개인 화면은 PC 연결 안내를 유지한다', () => {
        const markup = renderGate('unconnected');

        expect(markup).toContain('PC 연결이 필요합니다.');
        expect(markup).toContain('href="/connections"');
        expect(markup).not.toContain('개인 설정');
    });

    test('연결된 PWA에서만 개인 화면 내용을 렌더링한다', () => {
        expect(renderGate('connected')).toContain('개인 설정');
        expect(renderGate('checking')).toContain('PC 연결 상태를 확인하고 있습니다.');
        expect(renderGate('error')).toContain('PC 연결 상태를 확인하지 못했습니다.');
    });
});
