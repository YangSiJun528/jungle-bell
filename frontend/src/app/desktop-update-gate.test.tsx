import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {DesktopUpdateGate} from './desktop-update-gate';

const {environment, updateQuery} = vi.hoisted(() => ({
    environment: {
        platform: {kind: 'browser', capabilities: {desktopSettings: false}},
        checkDesktopUpdate: vi.fn<() => Promise<unknown>>(),
        installDesktopUpdate: vi.fn<() => Promise<void>>(),
    },
    updateQuery: {
        data: undefined as
            | undefined
            | {
                  currentVersion: string;
                  availableVersion: string | null;
                  mandatory: boolean;
              },
        isError: false,
        isPending: false,
        isFetching: false,
        refetch: vi.fn<() => Promise<unknown>>(),
    },
}));

vi.mock('@tanstack/react-query', () => ({
    useMutation: ({mutationFn}: {mutationFn: () => Promise<unknown>}) => ({
        isPending: false,
        isError: false,
        mutate: () => void mutationFn(),
    }),
    useQuery: () => updateQuery,
}));

vi.mock('./dashboard-context', () => ({
    queryKeys: {desktopUpdate: ['desktop-update'] as const},
    useDashboardEnvironment: () => ({
        api: {
            checkDesktopUpdate: environment.checkDesktopUpdate,
            installDesktopUpdate: environment.installDesktopUpdate,
        },
        platform: environment.platform,
    }),
}));

function renderGate(options: {
    platform: 'browser' | 'desktop';
    data?: typeof updateQuery.data;
    error?: boolean;
    pending?: boolean;
}): string {
    environment.platform =
        options.platform === 'desktop'
            ? {kind: 'desktop', capabilities: {desktopSettings: true}}
            : {kind: 'browser', capabilities: {desktopSettings: false}};
    updateQuery.data = options.data;
    updateQuery.isError = options.error ?? false;
    updateQuery.isPending = options.pending ?? false;
    routeRenderCount = 0;
    return renderToStaticMarkup(
        <DesktopUpdateGate>
            <RouteContent />
        </DesktopUpdateGate>,
    );
}

let routeRenderCount = 0;

function RouteContent() {
    routeRenderCount += 1;
    return <p data-route-content="true">대시보드</p>;
}

describe('DesktopUpdateGate', () => {
    test('웹과 PWA는 업데이트 확인 없이 대시보드를 연다', () => {
        const markup = renderGate({
            platform: 'browser',
            data: {currentVersion: '0.5.0', availableVersion: '0.6.0', mandatory: true},
        });

        expect(markup).toContain('대시보드');
        expect(routeRenderCount).toBe(1);
    });

    test('PC 앱은 업데이트 확인이 끝날 때까지 대시보드를 차단한다', () => {
        const markup = renderGate({platform: 'desktop', pending: true});

        expect(markup).toContain('최신 버전을 확인하고 있습니다.');
        expect(markup).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
    });

    test('같은 minor의 patch 업데이트는 대시보드를 차단하지 않는다', () => {
        const markup = renderGate({
            platform: 'desktop',
            data: {currentVersion: '0.5.0', availableVersion: '0.5.1', mandatory: false},
        });

        expect(markup).toContain('대시보드');
        expect(routeRenderCount).toBe(1);
    });

    test('정식 minor 업데이트는 설치 전까지 대시보드를 차단한다', () => {
        const markup = renderGate({
            platform: 'desktop',
            data: {currentVersion: '0.5.4', availableVersion: '0.6.0', mandatory: true},
        });

        expect(markup).toContain('PC 앱 업데이트가 필요합니다.');
        expect(markup).toContain('현재 v0.5.4');
        expect(markup).toContain('최신 정식 버전 v0.6.0');
        expect(markup).toContain('지금 업데이트');
        expect(markup).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
    });

    test('업데이트 확인 실패도 우회하지 않고 재시도를 제공한다', () => {
        const markup = renderGate({platform: 'desktop', error: true});

        expect(markup).toContain('업데이트 정보를 확인하지 못했습니다.');
        expect(markup).toContain('다시 확인');
        expect(markup).not.toContain('data-route-content');
        expect(routeRenderCount).toBe(0);
    });
});
