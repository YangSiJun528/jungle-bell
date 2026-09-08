import type {DashboardAccountStatus, PersonalAccessStatus} from '@/app/dashboard-account-state';
import type {PlatformKind} from '@/platform/contracts';

import type {AttendanceDetailModel} from './attendance-view-model';

type AvailableAttendanceDetail = Extract<AttendanceDetailModel, {kind: 'available'}>;

export type AttendanceRetryTarget = 'attendance' | 'browser-session' | 'desktop-connection';

export type AttendanceContentState =
    | {kind: 'loading'; label: string}
    | {kind: 'empty'; title: string; description?: string}
    | {kind: 'error'; title?: string; retryTarget: AttendanceRetryTarget}
    | {kind: 'available'; detail: AvailableAttendanceDetail};

export interface AttendancePageState {
    attendanceBusy: boolean;
    content: AttendanceContentState;
    desktopLmsRequired: boolean;
    desktopLocalAttendanceAvailable: boolean;
    refreshControl: {
        disabled: boolean;
        label: string;
    };
}

interface AttendancePageStateInput {
    accountStatus: DashboardAccountStatus;
    desktopAccount: boolean;
    detail: AttendanceDetailModel;
    personalAccessStatus: PersonalAccessStatus;
    platformKind: PlatformKind;
    refreshPending: boolean;
}

interface AttendanceAccessFlags {
    browserAccessChecking: boolean;
    browserAccessError: boolean;
    browserAccessUnavailable: boolean;
    browserAccessUnconnected: boolean;
    desktopLmsChecking: boolean;
    desktopLmsRequired: boolean;
    desktopLmsUnavailable: boolean;
    desktopLocalAttendanceAvailable: boolean;
    desktopSessionChecking: boolean;
    desktopSessionMissing: boolean;
    desktopSessionRecovery: boolean;
}

function attendanceAccessFlags({
    accountStatus,
    desktopAccount,
    detail,
    personalAccessStatus,
    platformKind,
}: Omit<AttendancePageStateInput, 'refreshPending'>): AttendanceAccessFlags {
    const desktopLocalAttendanceAvailable =
        desktopAccount && detail.kind === 'available' && detail.source === 'desktop';

    return {
        browserAccessChecking: platformKind === 'browser' && personalAccessStatus === 'checking',
        browserAccessError: platformKind === 'browser' && personalAccessStatus === 'error',
        browserAccessUnavailable:
            platformKind === 'browser' && personalAccessStatus === 'not-applicable',
        browserAccessUnconnected:
            platformKind === 'browser' && personalAccessStatus === 'unconnected',
        desktopLmsChecking: desktopAccount && accountStatus.lmsAuthentication === 'checking',
        desktopLmsRequired: desktopAccount && accountStatus.lmsAuthentication === 'required',
        desktopLmsUnavailable: desktopAccount && accountStatus.lmsAuthentication === 'unavailable',
        desktopLocalAttendanceAvailable,
        desktopSessionChecking:
            desktopAccount &&
            !desktopLocalAttendanceAvailable &&
            accountStatus.serverSession === 'checking',
        desktopSessionMissing:
            desktopAccount &&
            !desktopLocalAttendanceAvailable &&
            accountStatus.serverSession === 'missing',
        desktopSessionRecovery:
            desktopAccount &&
            !desktopLocalAttendanceAvailable &&
            accountStatus.serverSession === 'recovery-required',
    };
}

function attendanceContentState(
    flags: AttendanceAccessFlags,
    detail: AttendanceDetailModel,
): AttendanceContentState {
    if (flags.browserAccessUnavailable) {
        return {
            kind: 'empty',
            title: '앱 연결이 필요합니다.',
            description: '출석은 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다.',
        };
    }
    if (flags.browserAccessChecking) {
        return {kind: 'loading', label: 'PC 연결 상태를 확인하고 있습니다.'};
    }
    if (flags.browserAccessUnconnected) {
        return {
            kind: 'empty',
            title: 'PC 연결이 필요합니다.',
            description: 'PC 앱과 연결한 뒤 출석과 D-Day를 확인할 수 있습니다.',
        };
    }
    if (flags.browserAccessError) {
        return {
            kind: 'error',
            title: 'PC 연결 상태를 확인하지 못했습니다.',
            retryTarget: 'browser-session',
        };
    }
    if (flags.desktopLmsChecking) {
        return {kind: 'loading', label: 'LMS 로그인 상태를 확인하고 있습니다.'};
    }
    if (flags.desktopLmsRequired) {
        return {kind: 'empty', title: 'LMS 로그인이 필요합니다.'};
    }
    if (flags.desktopLmsUnavailable) {
        return {
            kind: 'error',
            title: 'LMS 로그인 상태를 확인하지 못했습니다.',
            retryTarget: 'desktop-connection',
        };
    }
    if (flags.desktopSessionChecking) {
        return {kind: 'loading', label: '계정 연결 상태를 확인하고 있습니다.'};
    }
    if (flags.desktopSessionRecovery) {
        return {
            kind: 'empty',
            title: '계정 복구가 필요합니다.',
            description: '연결 설정에서 PC 연결 정보를 복구하세요.',
        };
    }
    if (flags.desktopSessionMissing) {
        return {
            kind: 'empty',
            title: '계정 연결이 필요합니다.',
            description: '계정 연결을 누르면 출석 동기화를 시작합니다.',
        };
    }
    if (detail.kind === 'loading') {
        return {kind: 'loading', label: '출석 정보를 확인하고 있습니다.'};
    }
    if (detail.kind === 'error') {
        return {kind: 'error', retryTarget: 'attendance'};
    }
    if (detail.kind === 'auth-required') {
        return {
            kind: 'empty',
            title: 'PC 연결이 필요합니다.',
            description: 'PC 앱과 연결한 뒤 최신 출석 상태를 확인할 수 있습니다.',
        };
    }
    if (detail.kind === 'unavailable') {
        return {
            kind: 'empty',
            title: '출석 확인 대기 중',
            description: '아직 PC에서 동기화한 출석 정보가 없습니다.',
        };
    }
    return {kind: 'available', detail};
}

function refreshControl(
    flags: AttendanceAccessFlags,
    personalAccessStatus: PersonalAccessStatus,
    refreshPending: boolean,
): AttendancePageState['refreshControl'] {
    const disabled =
        refreshPending ||
        (personalAccessStatus !== 'connected' && !flags.desktopLocalAttendanceAvailable) ||
        flags.desktopLmsChecking ||
        flags.desktopLmsUnavailable ||
        flags.desktopSessionChecking ||
        flags.desktopSessionRecovery;
    const label = refreshPending
        ? '새로고침 중'
        : flags.desktopLmsChecking
          ? '인증 확인 중'
          : flags.desktopSessionMissing
            ? '계정 연결'
            : '새로고침';

    return {disabled, label};
}

export function resolveAttendancePageState(input: AttendancePageStateInput): AttendancePageState {
    const flags = attendanceAccessFlags(input);

    return {
        attendanceBusy: !flags.browserAccessUnavailable && input.detail.kind === 'loading',
        content: attendanceContentState(flags, input.detail),
        desktopLmsRequired: flags.desktopLmsRequired,
        desktopLocalAttendanceAvailable: flags.desktopLocalAttendanceAvailable,
        refreshControl: refreshControl(flags, input.personalAccessStatus, input.refreshPending),
    };
}
