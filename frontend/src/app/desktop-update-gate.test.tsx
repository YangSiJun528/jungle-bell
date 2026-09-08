import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {DesktopUpdateStatus} from '@/platform/contracts';

import {DesktopUpdateGate} from './desktop-update-gate';
import {desktopUpdateGateDecision} from './desktop-update-gate-decision';

const {environment, updateQuery} = vi.hoisted(() => ({
    environment: {
        platform: {kind: 'browser', capabilities: {desktopSettings: false}},
        checkDesktopUpdate: vi.fn<() => Promise<unknown>>(),
        installDesktopUpdate: vi.fn<() => Promise<void>>(),
        openLogFolder: vi.fn<() => Promise<void>>(),
    },
    updateQuery: {
        data: undefined as DesktopUpdateStatus | undefined,
        isError: false,
        isPending: false,
        isFetching: false,
        refetch: vi.fn<() => Promise<unknown>>(),
    },
}));

vi.mock('@tanstack/react-query', () => ({
    useIsMutating: () => 0,
    useQueryClient: () => ({invalidateQueries: vi.fn<() => Promise<void>>()}),
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
        api: environment,
        platform: environment.platform,
    }),
}));

function status(
    updateStatus: DesktopUpdateStatus['status'],
    overrides: Partial<DesktopUpdateStatus> = {},
): DesktopUpdateStatus {
    return {
        currentVersion: '0.5.4',
        availableVersion: updateStatus === 'latest' ? null : '0.6.0',
        status: updateStatus,
        policy: updateStatus === 'latest' ? null : 'mandatory',
        progress: null,
        errorCode: updateStatus === 'failed' ? 'UPDATE_INSTALL_FAILED' : null,
        ...overrides,
    };
}

function renderGate(options: {
    platform: 'browser' | 'desktop';
    data?: DesktopUpdateStatus;
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
        const markup = renderGate({platform: 'browser', data: status('mandatory')});

        expect(markup).toContain('대시보드');
        expect(routeRenderCount).toBe(1);
    });

    test('PC 최초 확인 중에는 대시보드를 inert로 만들고 안정적인 overlay를 표시한다', () => {
        const markup = renderGate({platform: 'desktop', pending: true});

        expect(markup).toContain('업데이트 확인 중');
        expect(markup).toContain('data-route-content');
        expect(markup).toContain('inert=""');
        expect(markup).toContain('aria-hidden="true"');
        expect(routeRenderCount).toBe(1);
    });

    test('최초 확인 실패는 복구 경로가 있는 차단 화면을 표시한다', () => {
        const markup = renderGate({platform: 'desktop', error: true});

        expect(markup).toContain('업데이트를 확인하지 못했습니다');
        expect(markup).toContain('최신 버전 확인 단계에서 실패했습니다');
        expect(markup).toContain('다시 확인');
        expect(markup).toContain('인터넷 연결');
        expect(markup).toContain('로그 폴더 열기');
        expect(markup).toContain('수동 설치');
        expect(markup).toContain('inert=""');
    });

    test('optional과 latest 결과는 대시보드를 연다', () => {
        expect(
            renderGate({
                platform: 'desktop',
                data: status('optional', {policy: 'optional', availableVersion: '0.5.5'}),
            }),
        ).toContain('대시보드');
        expect(renderGate({platform: 'desktop', data: status('latest')})).toContain('대시보드');
    });

    test('mandatory 업데이트는 설치 전까지 차단하고 실제 결과를 버튼에 설명한다', () => {
        const markup = renderGate({platform: 'desktop', data: status('mandatory')});

        expect(markup).toContain('PC 앱 업데이트가 필요합니다');
        expect(markup).toContain('현재 v0.5.4');
        expect(markup).toContain('최신 정식 버전 v0.6.0');
        expect(markup).toContain('업데이트하고 재시작');
        expect(markup).toContain('inert=""');
        expect(routeRenderCount).toBe(1);
    });

    test('새 확인 오류가 나도 cached mandatory 결과로 차단을 유지한다', () => {
        const markup = renderGate({
            platform: 'desktop',
            data: status('mandatory'),
            error: true,
        });

        expect(markup).toContain('PC 앱 업데이트가 필요합니다');
        expect(markup).toContain('inert=""');
        expect(routeRenderCount).toBe(1);
    });

    test.each([
        ['downloading', '업데이트 다운로드 중'],
        ['verifying', '업데이트 검증 중'],
        ['installing', '업데이트 설치 중'],
        ['restart-required', '재시작 준비 완료'],
    ] as const)('%s 단계와 진행 상태를 표시한다', (updateStatus, label) => {
        const markup = renderGate({
            platform: 'desktop',
            data: status(updateStatus, {
                progress: {downloadedBytes: 50, totalBytes: 100},
            }),
        });

        expect(markup).toContain(label);
        expect(markup).toContain('<progress');
        expect(markup).toContain('inert=""');
    });

    test('mandatory 실패는 요약과 재시도, 네트워크, 로그, 수동 설치 경로를 모두 제공한다', () => {
        const markup = renderGate({platform: 'desktop', data: status('failed')});

        expect(markup).toContain('업데이트를 완료하지 못했습니다');
        expect(markup).toContain('설치 단계에서 실패했습니다');
        expect(markup).toContain('업데이트 다시 시도');
        expect(markup).toContain('인터넷 연결');
        expect(markup).toContain('로그 폴더 열기');
        expect(markup).toContain('수동 설치');
        expect(markup).toContain(
            'href="https://github.com/YangSiJun528/jungle-bell/releases/latest"',
        );
        expect(markup).toContain('inert=""');
    });

    test('이미 열린 대시보드는 뒤늦은 mandatory에서도 mount를 보존하고 overlay로 차단한다', () => {
        expect(
            desktopUpdateGateDecision({
                desktop: true,
                data: status('mandatory'),
                queryPending: false,
                queryError: false,
            }),
        ).toMatchObject({renderDashboard: true, blocked: true});
    });
});
