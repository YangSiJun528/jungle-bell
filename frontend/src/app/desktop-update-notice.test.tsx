import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {DesktopUpdateStatus} from '@/platform/contracts';

import {queryKeys} from './dashboard-context';
import {deferOptionalDesktopUpdate, isOptionalDesktopUpdateDeferred} from './desktop-update-later';
import {DesktopUpdateNotice} from './desktop-update-notice';

const {environment} = vi.hoisted(() => ({
    environment: {
        api: {
            checkDesktopUpdate: vi.fn<() => Promise<unknown>>(),
            installDesktopUpdate: vi.fn<() => Promise<void>>(),
            openLogFolder: vi.fn<() => Promise<void>>(),
        },
        platform: {kind: 'desktop', capabilities: {desktopSettings: true}},
    },
}));

vi.mock('@/app/dashboard-context', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/app/dashboard-context')>()),
    useDashboardEnvironment: () => environment,
}));

function status(
    updateStatus: DesktopUpdateStatus['status'],
    overrides: Partial<DesktopUpdateStatus> = {},
): DesktopUpdateStatus {
    return {
        currentVersion: '0.5.0',
        availableVersion: updateStatus === 'latest' ? null : '0.5.1',
        status: updateStatus,
        policy: updateStatus === 'latest' ? null : 'optional',
        progress: null,
        errorCode: updateStatus === 'failed' ? 'UPDATE_DOWNLOAD_FAILED' : null,
        ...overrides,
    };
}

function renderNotice(data: DesktopUpdateStatus): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.desktopUpdate, data);
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <DesktopUpdateNotice />
        </QueryClientProvider>,
    );
}

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
}

describe('DesktopUpdateNotice', () => {
    test('optional 업데이트는 실제 결과 버튼과 나중에 정책을 표시한다', () => {
        const markup = renderNotice(status('optional'));

        expect(markup).toContain('Jungle Bell 업데이트가 있습니다');
        expect(markup).toContain('현재 v0.5.0');
        expect(markup).toContain('최신 v0.5.1');
        expect(markup).toContain('업데이트하고 재시작');
        expect(markup).toContain('나중에');
    });

    test('latest와 mandatory는 optional 안내를 숨긴다', () => {
        expect(renderNotice(status('latest'))).toBe('');
        expect(
            renderNotice(status('mandatory', {policy: 'mandatory', availableVersion: '0.6.0'})),
        ).toBe('');
    });

    test('optional 설치 중에도 다운로드 진행 상태를 유지한다', () => {
        const markup = renderNotice(
            status('downloading', {progress: {downloadedBytes: 25, totalBytes: 100}}),
        );

        expect(markup).toContain('업데이트 다운로드 중');
        expect(markup).toContain('<progress');
        expect(markup).toContain('25%');
    });

    test('optional 설치 실패도 복구 경로를 제공한다', () => {
        const markup = renderNotice(status('failed'));

        expect(markup).toContain('다운로드 단계에서 실패했습니다');
        expect(markup).toContain('업데이트 다시 시도');
        expect(markup).toContain('로그 폴더 열기');
        expect(markup).toContain('수동 설치');
    });

    test('나중에는 같은 앱 세션의 같은 버전만 숨기고 새 버전은 다시 표시한다', () => {
        const storage = memoryStorage();

        expect(isOptionalDesktopUpdateDeferred('0.5.1', storage)).toBe(false);
        deferOptionalDesktopUpdate('0.5.1', storage);
        expect(isOptionalDesktopUpdateDeferred('0.5.1', storage)).toBe(true);
        expect(isOptionalDesktopUpdateDeferred('0.5.2', storage)).toBe(false);
    });

    test('저장소가 막히거나 값이 손상되면 optional 안내를 숨기지 않는다', () => {
        const blockedStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        const malformedStorage = {
            getItem: () => '{not-json',
            setItem: vi.fn<(key: string, value: string) => void>(),
        };

        expect(isOptionalDesktopUpdateDeferred('0.5.1', blockedStorage)).toBe(false);
        expect(isOptionalDesktopUpdateDeferred('0.5.1', malformedStorage)).toBe(false);
        expect(() => deferOptionalDesktopUpdate('0.5.1', blockedStorage)).not.toThrow();
    });
});
