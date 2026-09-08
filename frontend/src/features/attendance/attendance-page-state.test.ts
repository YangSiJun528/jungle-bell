import {describe, expect, it} from 'vitest';

import {resolveAttendancePageState} from './attendance-page-state';

type StateInput = Parameters<typeof resolveAttendancePageState>[0];

const availableDetail = {
    kind: 'available',
    freshness: 'fresh',
    lastSyncedAt: '2026-08-11T00:00:00.000Z',
    snapshot: {
        attendanceDate: '2026-08-11',
        cohortId: null,
        cohortStatus: 'active',
        cohortStartDate: null,
        cohortEndDate: null,
        morningChecked: true,
        eveningChecked: false,
        collectedAt: '2026-08-11T00:00:00.000Z',
    },
    source: 'server',
    syncState: 'synced',
} as const;

const baseInput: StateInput = {
    accountStatus: {
        lmsAuthentication: 'authenticated',
        serverSession: 'stored',
    },
    desktopAccount: false,
    detail: availableDetail,
    personalAccessStatus: 'connected',
    platformKind: 'browser',
    refreshPending: false,
};

function resolve(overrides: Partial<StateInput> = {}) {
    return resolveAttendancePageState({...baseInput, ...overrides});
}

describe('resolveAttendancePageState', () => {
    it.each([
        {
            status: 'not-applicable',
            expected: {
                kind: 'empty',
                title: '앱 연결이 필요합니다.',
                description: '출석은 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다.',
            },
        },
        {
            status: 'checking',
            expected: {kind: 'loading', label: 'PC 연결 상태를 확인하고 있습니다.'},
        },
        {
            status: 'unconnected',
            expected: {
                kind: 'empty',
                title: 'PC 연결이 필요합니다.',
                description: 'PC 앱과 연결한 뒤 출석과 D-Day를 확인할 수 있습니다.',
            },
        },
        {
            status: 'error',
            expected: {
                kind: 'error',
                title: 'PC 연결 상태를 확인하지 못했습니다.',
                retryTarget: 'browser-session',
            },
        },
    ] as const)('브라우저 개인 접근 $status 상태를 우선 표시한다', ({status, expected}) => {
        expect(resolve({personalAccessStatus: status}).content).toEqual(expected);
    });

    it.each([
        {
            accountStatus: {lmsAuthentication: 'checking', serverSession: 'stored'},
            expected: {kind: 'loading', label: 'LMS 로그인 상태를 확인하고 있습니다.'},
        },
        {
            accountStatus: {lmsAuthentication: 'required', serverSession: 'stored'},
            expected: {kind: 'empty', title: 'LMS 로그인이 필요합니다.'},
        },
        {
            accountStatus: {lmsAuthentication: 'unavailable', serverSession: 'stored'},
            expected: {
                kind: 'error',
                title: 'LMS 로그인 상태를 확인하지 못했습니다.',
                retryTarget: 'desktop-connection',
            },
        },
        {
            accountStatus: {lmsAuthentication: 'authenticated', serverSession: 'checking'},
            expected: {kind: 'loading', label: '계정 연결 상태를 확인하고 있습니다.'},
        },
        {
            accountStatus: {
                lmsAuthentication: 'authenticated',
                serverSession: 'recovery-required',
            },
            expected: {
                kind: 'empty',
                title: '계정 복구가 필요합니다.',
                description: '연결 설정에서 PC 연결 정보를 복구하세요.',
            },
        },
        {
            accountStatus: {lmsAuthentication: 'authenticated', serverSession: 'missing'},
            expected: {
                kind: 'empty',
                title: '계정 연결이 필요합니다.',
                description: '계정 연결을 누르면 출석 동기화를 시작합니다.',
            },
        },
    ] as const)('PC 인증·세션 게이트를 기존 우선순위로 표시한다', ({accountStatus, expected}) => {
        expect(
            resolve({
                accountStatus,
                desktopAccount: true,
                platformKind: 'desktop',
            }).content,
        ).toEqual(expected);
    });

    it('PC 로컬 관측은 서버 세션 누락과 개인 접근 상태를 우회한다', () => {
        const state = resolve({
            accountStatus: {lmsAuthentication: 'authenticated', serverSession: 'missing'},
            desktopAccount: true,
            detail: {...availableDetail, source: 'desktop', syncState: 'pending'},
            personalAccessStatus: 'unconnected',
            platformKind: 'desktop',
        });

        expect(state.desktopLocalAttendanceAvailable).toBe(true);
        expect(state.content).toMatchObject({kind: 'available', detail: {source: 'desktop'}});
        expect(state.refreshControl).toEqual({disabled: false, label: '새로고침'});
    });

    it('조회 실패의 재시도 대상과 새로고침 진행 상태를 보존한다', () => {
        expect(resolve({detail: {kind: 'error'}}).content).toEqual({
            kind: 'error',
            retryTarget: 'attendance',
        });
        expect(resolve({detail: {kind: 'loading'}}).attendanceBusy).toBe(true);
        expect(resolve({refreshPending: true}).refreshControl).toEqual({
            disabled: true,
            label: '새로고침 중',
        });
    });

    it('LMS 로그인 필요 상태는 헤더 로그인 동작을 선택한다', () => {
        const state = resolve({
            accountStatus: {lmsAuthentication: 'required', serverSession: 'stored'},
            desktopAccount: true,
            platformKind: 'desktop',
        });

        expect(state.desktopLmsRequired).toBe(true);
        expect(state.refreshControl.disabled).toBe(false);
    });
});
