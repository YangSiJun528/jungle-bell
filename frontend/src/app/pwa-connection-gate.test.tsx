import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import {PwaConnectionGate} from './pwa-connection-gate';

const {account, environment} = vi.hoisted(() => ({
    account: {
        personalAccess: 'unconnected',
        refetch: vi.fn(),
    },
    environment: {
        authentication: 'cookie',
    },
}));

vi.mock('./dashboard-account', () => ({
    useDashboardAccount: () => ({
        personalAccess: {status: account.personalAccess},
        browserSessionQuery: {
            isFetching: false,
            refetch: account.refetch,
        },
    }),
}));

vi.mock('./dashboard-context', () => ({
    useDashboardEnvironment: () => ({
        platform: {
            accountAuthentication: {kind: environment.authentication},
        },
    }),
}));

function renderGate(authentication: string, status: string): string {
    environment.authentication = authentication;
    account.personalAccess = status;
    return renderToStaticMarkup(
        <PwaConnectionGate connectionContent={<p>기기 연결 화면</p>}>
            <p>대시보드</p>
        </PwaConnectionGate>,
    );
}

describe('PwaConnectionGate', () => {
    test('일반 웹과 PC는 전역 연결 게이트를 적용하지 않는다', () => {
        expect(renderGate('none', 'not-applicable')).toContain('대시보드');
        expect(renderGate('desktop-session', 'connected')).toContain('대시보드');
    });

    test('연결된 PWA만 공통 대시보드를 렌더링한다', () => {
        expect(renderGate('cookie', 'connected')).toContain('대시보드');

        const checking = renderGate('cookie', 'checking');
        expect(checking).toContain('PC 연결 상태를 확인하고 있습니다.');
        expect(checking).not.toContain('대시보드');

        const error = renderGate('cookie', 'error');
        expect(error).toContain('PC 연결 상태를 확인하지 못했습니다.');
        expect(error).not.toContain('대시보드');
    });

    test('미연결 PWA는 연결 화면 외의 기능을 차단한다', () => {
        const markup = renderGate('cookie', 'unconnected');

        expect(markup).toContain('PC 앱 연결이 필요합니다.');
        expect(markup).toContain('연결하기 전에는 Jungle Bell을 사용할 수 없습니다.');
        expect(markup).toContain('기기 연결 화면');
        expect(markup).not.toContain('대시보드');
    });
});
