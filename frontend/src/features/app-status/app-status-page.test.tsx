import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

import type {DesktopUpdateStatus} from '@/platform/contracts';

import {desktopUpdateState} from './app-status-page';

const source = readFileSync(new URL('./app-status-page.tsx', import.meta.url), 'utf8');

const checkedAtEpochMs = Date.parse('2026-09-08T01:00:00.000Z');

function updateQuery(data: DesktopUpdateStatus) {
    return {
        data,
        dataUpdatedAt: checkedAtEpochMs,
        isError: false,
        isPending: false,
    };
}

function updateStatus(
    status: DesktopUpdateStatus['status'],
    overrides: Partial<DesktopUpdateStatus> = {},
): DesktopUpdateStatus {
    return {
        currentVersion: '0.5.9',
        availableVersion: '0.6.0',
        status,
        policy: 'optional',
        progress: null,
        errorCode: null,
        ...overrides,
    };
}

describe('AppStatusPage', () => {
    test('상태 행마다 상태 텍스트, 복구 동작, polite live feedback을 제공한다', () => {
        expect(source).toContain('aria-live="polite"');
        expect(source).toContain('row.action');
        expect(source).toContain('AppStatusRow');
        expect(source).toContain('앱 상태');
    });

    test('현재 계약으로 확인할 수 없는 값은 확인 불가로 표시한다', () => {
        expect(source).toContain('확인 불가');
        expect(source).toContain('현재 계약에서 확인할 수 없습니다.');
    });

    test('canonical 업데이트의 checking과 failed를 각각 확인 중과 오류로 매핑한다', () => {
        expect(
            desktopUpdateState(
                updateQuery(
                    updateStatus('checking', {
                        availableVersion: null,
                        policy: null,
                    }),
                ),
            ),
        ).toEqual({kind: 'checking'});
        expect(
            desktopUpdateState(
                updateQuery(updateStatus('failed', {errorCode: 'UPDATE_CHECK_FAILED'})),
            ),
        ).toEqual({kind: 'error'});
    });

    test('latest 또는 availableVersion이 없는 완료 상태를 최신으로 매핑한다', () => {
        expect(
            desktopUpdateState(
                updateQuery(
                    updateStatus('latest', {
                        availableVersion: null,
                        policy: null,
                    }),
                ),
            ),
        ).toEqual({kind: 'latest', checkedAt: '2026-09-08T01:00:00.000Z'});
    });

    test.each([
        ['optional', 'optional', null, false],
        ['mandatory', 'mandatory', null, true],
        ['downloading', 'mandatory', {downloadedBytes: 10, totalBytes: 100}, true],
        ['verifying', 'optional', {downloadedBytes: 100, totalBytes: 100}, false],
        ['installing', 'mandatory', {downloadedBytes: 100, totalBytes: 100}, true],
        ['restart-required', 'optional', {downloadedBytes: 100, totalBytes: 100}, false],
    ] as const)(
        '%s 업데이트를 available로 표시하고 mandatory는 policy에서 계산한다',
        (status, policy, progress, mandatory) => {
            expect(
                desktopUpdateState(updateQuery(updateStatus(status, {policy, progress}))),
            ).toEqual({
                kind: 'available',
                availableVersion: '0.6.0',
                mandatory,
                checkedAt: '2026-09-08T01:00:00.000Z',
            });
        },
    );
});
