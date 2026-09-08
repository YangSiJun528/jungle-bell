import type {
    LmsAuthenticationStatus,
    PersonalAccessStatus,
    ServerSessionStatus,
} from '@/app/dashboard-account-state';
import {dateTimeLabel} from '@/lib/format';

export type AppStatusValue = 'attention' | 'checking' | 'error' | 'ready' | 'unavailable';

export type AppStatusTab = 'devices' | 'notifications';

export interface AppStatusAction {
    href: string;
    label: string;
    tab?: AppStatusTab;
}

export interface AppStatusRowModel {
    action: AppStatusAction;
    description: string;
    id: string;
    label: string;
    status: AppStatusValue;
    statusText: string;
}

type ObservableValue<T> = T | 'checking' | 'unavailable';

export type DesktopUpdateState =
    | {kind: 'available'; availableVersion: string; checkedAt?: string | null; mandatory?: boolean}
    | {kind: 'checking'}
    | {kind: 'error'}
    | {kind: 'latest'; checkedAt?: string | null}
    | {kind: 'unavailable'};

export interface DesktopSyncObservation {
    kind: 'pending' | 'stale';
    observedAt: string;
}

export interface DesktopAppStatusInput {
    surface: 'desktop';
    lmsAuthentication: LmsAuthenticationStatus;
    serverSession: ServerSessionStatus;
    lastSyncedAt: ObservableValue<DesktopSyncObservation | string | null>;
    mobileSessionCount: ObservableValue<number | null>;
    update: DesktopUpdateState;
}

export type AppNotificationPermission = NotificationPermission | 'unavailable';

export interface PwaAppStatusInput {
    surface: 'pwa';
    personalAccess: PersonalAccessStatus;
    sessionExpiresAt: ObservableValue<string | null>;
    notificationPermission: AppNotificationPermission;
}

export interface WebAppStatusInput {
    surface: 'web';
    installSupported: boolean;
    installed: boolean;
}

export type AppStatusInput = DesktopAppStatusInput | PwaAppStatusInput | WebAppStatusInput;

const UNAVAILABLE_DESCRIPTION = '현재 계약에서 확인할 수 없습니다.';

const DEVICE_ACTION: AppStatusAction = {
    href: '#/connections?tab=devices',
    label: '기기 연결 열기',
    tab: 'devices',
};

const NOTIFICATION_ACTION: AppStatusAction = {
    href: '#/connections?tab=notifications',
    label: '알림 설정 열기',
    tab: 'notifications',
};

const INSTALL_ACTION: AppStatusAction = {
    href: '#/install',
    label: '설치 안내 열기',
};

function unavailableRow(id: string, label: string, action: AppStatusAction): AppStatusRowModel {
    return {
        id,
        label,
        status: 'unavailable',
        statusText: '확인 불가',
        description: UNAVAILABLE_DESCRIPTION,
        action,
    };
}

function lmsAuthenticationRow(value: LmsAuthenticationStatus): AppStatusRowModel {
    const base = {
        id: 'lms-authentication',
        label: 'Jungle Campus 로그인',
        action: DEVICE_ACTION,
    };
    if (value === 'authenticated') {
        return {
            ...base,
            status: 'ready',
            statusText: '로그인됨',
            description: 'PC 앱이 Jungle Campus 로그인 상태를 확인했습니다.',
        };
    }
    if (value === 'required') {
        return {
            ...base,
            status: 'attention',
            statusText: '로그인 필요',
            description: '출석 동기화를 계속하려면 다시 로그인해야 합니다.',
        };
    }
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: 'PC 앱에서 로그인 상태를 확인하고 있습니다.',
        };
    }
    return unavailableRow(base.id, base.label, base.action);
}

function serverCredentialRow(value: ServerSessionStatus): AppStatusRowModel {
    const base = {
        id: 'server-credential',
        label: 'PC 서버 인증 정보',
        action: DEVICE_ACTION,
    };
    if (value === 'stored') {
        return {
            ...base,
            status: 'ready',
            statusText: '안전하게 저장됨',
            description: '앱을 다시 시작해도 서버 연결을 복구할 수 있습니다.',
        };
    }
    if (value === 'memory-only') {
        return {
            ...base,
            status: 'attention',
            statusText: '이번 실행에서만 유지',
            description: '앱을 다시 시작하면 서버 연결 복구가 필요할 수 있습니다.',
        };
    }
    if (value === 'missing') {
        return {
            ...base,
            status: 'attention',
            statusText: '등록 필요',
            description: '기기 연결에서 이 PC를 서버에 등록해 주세요.',
        };
    }
    if (value === 'recovery-required') {
        return {
            ...base,
            status: 'error',
            statusText: '복구 필요',
            description:
                '저장된 credential과 서버 등록 identity가 일치하지 않습니다. 기기 연결에서 상태를 확인해 주세요.',
        };
    }
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '저장된 PC 인증 정보를 확인하고 있습니다.',
        };
    }
    return unavailableRow(base.id, base.label, base.action);
}

function lastSyncRow(value: DesktopAppStatusInput['lastSyncedAt']): AppStatusRowModel {
    const base = {
        id: 'last-sync',
        label: '최근 출석 동기화',
        action: DEVICE_ACTION,
    };
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '최근 출석 동기화 기록을 확인하고 있습니다.',
        };
    }
    if (value === 'unavailable') return unavailableRow(base.id, base.label, base.action);
    if (value === null) {
        return {
            ...base,
            status: 'attention',
            statusText: '동기화 기록 없음',
            description: 'Jungle Campus 로그인과 PC 연결을 확인해 주세요.',
        };
    }
    if (typeof value === 'object') {
        const observedAt = dateTimeLabel(value.observedAt);
        if (value.kind === 'stale') {
            return {
                ...base,
                status: 'attention',
                statusText: '오래된 동기화',
                description:
                    observedAt === '확인 기록 없음'
                        ? '마지막 출석 동기화 시각을 신뢰할 수 없습니다.'
                        : `${observedAt} 이후 최신 출석 동기화를 확인하지 못했습니다.`,
            };
        }
        return {
            ...base,
            status: 'attention',
            statusText: '서버 반영 대기',
            description:
                observedAt === '확인 기록 없음'
                    ? 'PC에서 새 출석 상태를 확인했지만 서버 반영은 아직 완료되지 않았습니다.'
                    : `${observedAt}에 확인한 출석 상태를 서버에 반영하고 있습니다.`,
        };
    }
    const label = dateTimeLabel(value);
    if (label === '확인 기록 없음') return unavailableRow(base.id, base.label, base.action);
    return {
        ...base,
        status: 'ready',
        statusText: `마지막 동기화 ${label}`,
        description: '서버에서 읽은 최신 출석 동기화 시각입니다.',
    };
}

function mobileSessionsRow(value: DesktopAppStatusInput['mobileSessionCount']): AppStatusRowModel {
    const base = {
        id: 'mobile-sessions',
        label: '연결된 모바일',
        action: DEVICE_ACTION,
    };
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '활성 모바일 세션을 확인하고 있습니다.',
        };
    }
    if (value === 'unavailable' || value === null) {
        return unavailableRow(base.id, base.label, base.action);
    }
    if (value === 0) {
        return {
            ...base,
            status: 'attention',
            statusText: '연결된 모바일 없음',
            description: '모바일 푸시를 받으려면 PWA를 이 PC와 연결해야 합니다.',
        };
    }
    return {
        ...base,
        status: 'ready',
        statusText: `${value}대 연결됨`,
        description: '서버가 반환한 활성 모바일 세션 수입니다.',
    };
}

function desktopUpdateRow(value: DesktopUpdateState): AppStatusRowModel {
    const action: AppStatusAction = {
        href: '#/connections?tab=services',
        label: '앱 업데이트 열기',
    };
    const base = {id: 'update', label: 'PC 앱 업데이트', action};
    if (value.kind === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '업데이트 상태를 확인하고 있습니다.',
        };
    }
    if (value.kind === 'error') {
        return {
            ...base,
            status: 'error',
            statusText: '확인 실패',
            description: '네트워크를 확인한 뒤 업데이트 화면에서 다시 시도해 주세요.',
        };
    }
    if (value.kind === 'unavailable') return unavailableRow(base.id, base.label, base.action);
    const checkedAt = value.checkedAt ? dateTimeLabel(value.checkedAt) : null;
    if (value.kind === 'available') {
        return {
            ...base,
            status: 'attention',
            statusText: `${value.availableVersion} 업데이트 가능`,
            description: value.mandatory
                ? '계속 사용하려면 최신 정식 버전을 설치해야 합니다.'
                : `새 버전을 설치할 수 있습니다${checkedAt ? ` · ${checkedAt} 확인` : ''}.`,
        };
    }
    return {
        ...base,
        status: 'ready',
        statusText: '최신 버전',
        description: checkedAt
            ? `${checkedAt}에 업데이트를 확인했습니다.`
            : '사용 가능한 업데이트가 없습니다.',
    };
}

function desktopRows(input: DesktopAppStatusInput): AppStatusRowModel[] {
    return [
        lmsAuthenticationRow(input.lmsAuthentication),
        serverCredentialRow(input.serverSession),
        lastSyncRow(input.lastSyncedAt),
        mobileSessionsRow(input.mobileSessionCount),
        unavailableRow('os-notification', '운영체제 알림 표시', NOTIFICATION_ACTION),
        desktopUpdateRow(input.update),
    ];
}

function personalAccessRow(value: PersonalAccessStatus): AppStatusRowModel {
    const base = {id: 'personal-access', label: 'PC 계정 연결', action: DEVICE_ACTION};
    if (value === 'connected') {
        return {
            ...base,
            status: 'ready',
            statusText: '연결됨',
            description: '이 PWA가 개인 기능을 사용할 수 있습니다.',
        };
    }
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '현재 모바일 세션을 확인하고 있습니다.',
        };
    }
    if (value === 'unconnected') {
        return {
            ...base,
            status: 'attention',
            statusText: '연결 필요',
            description: 'PC 앱에서 새 연결 코드를 만들어 이 PWA를 연결해 주세요.',
        };
    }
    if (value === 'error') {
        return {
            ...base,
            status: 'error',
            statusText: '확인 실패',
            description: '네트워크를 확인한 뒤 기기 연결 화면에서 다시 시도해 주세요.',
        };
    }
    return unavailableRow(base.id, base.label, base.action);
}

function sessionExpiryRow(
    value: PwaAppStatusInput['sessionExpiresAt'],
    now: number,
): AppStatusRowModel {
    const base = {id: 'session-expiry', label: '모바일 세션 만료', action: DEVICE_ACTION};
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '현재 세션의 만료 시각을 확인하고 있습니다.',
        };
    }
    if (value === 'unavailable') {
        return unavailableRow(base.id, base.label, base.action);
    }
    if (value === null) {
        return {
            ...base,
            status: 'attention',
            statusText: '세션 없음',
            description: '개인 기능을 사용하려면 PC와 연결해 새 모바일 세션을 만들어야 합니다.',
        };
    }
    const expiresAt = Date.parse(value);
    if (!Number.isFinite(expiresAt)) return unavailableRow(base.id, base.label, base.action);
    if (expiresAt <= now) {
        return {
            ...base,
            status: 'attention',
            statusText: '만료됨',
            description: '개인 기능을 다시 사용하려면 PC와 다시 연결해야 합니다.',
        };
    }
    return {
        ...base,
        status: 'ready',
        statusText: `${dateTimeLabel(value)}까지`,
        description: '서버가 반환한 현재 모바일 세션 만료 시각입니다.',
    };
}

function notificationPermissionRow(value: AppNotificationPermission): AppStatusRowModel {
    const base = {
        id: 'notification-permission',
        label: '알림 권한',
        action: NOTIFICATION_ACTION,
    };
    if (value === 'granted') {
        return {
            ...base,
            status: 'ready',
            statusText: '허용됨',
            description: '브라우저 알림 권한이 허용된 상태입니다.',
        };
    }
    if (value === 'denied') {
        return {
            ...base,
            status: 'attention',
            statusText: '차단됨',
            description: '브라우저 또는 운영체제 설정에서 Jungle Bell 알림을 허용해 주세요.',
        };
    }
    if (value === 'default') {
        return {
            ...base,
            status: 'attention',
            statusText: '권한 선택 전',
            description: '알림 설정에서 푸시 연결을 시작해 권한을 선택해 주세요.',
        };
    }
    return unavailableRow(base.id, base.label, base.action);
}

function pwaRows(input: PwaAppStatusInput, now: number): AppStatusRowModel[] {
    return [
        personalAccessRow(input.personalAccess),
        sessionExpiryRow(input.sessionExpiresAt, now),
        notificationPermissionRow(input.notificationPermission),
        unavailableRow('local-push', '로컬 푸시 구독', NOTIFICATION_ACTION),
        unavailableRow('server-registration', '서버 푸시 등록', NOTIFICATION_ACTION),
        unavailableRow('last-test', '마지막 테스트 알림', NOTIFICATION_ACTION),
        unavailableRow('service-worker', '서비스 워커', NOTIFICATION_ACTION),
    ];
}

function webRows(input: WebAppStatusInput): AppStatusRowModel[] {
    const publicAccess: AppStatusRowModel = {
        id: 'public-access',
        label: '공개 기능',
        status: 'ready',
        statusText: '사용 가능',
        description: '설치나 계정 연결 없이 공개 세탁실·식단 정보를 사용할 수 있습니다.',
        action: {href: '#/home', label: '홈 열기'},
    };
    const installSupport: AppStatusRowModel = input.installSupported
        ? {
              id: 'install-support',
              label: 'PWA 설치 지원',
              status: 'ready',
              statusText: '지원됨',
              description: '이 브라우저에서 Jungle Bell 설치 안내를 사용할 수 있습니다.',
              action: INSTALL_ACTION,
          }
        : {
              id: 'install-support',
              label: 'PWA 설치 지원',
              status: 'attention',
              statusText: '지원되지 않음',
              description: '현재 브라우저에서는 PWA 설치 기능을 사용할 수 없습니다.',
              action: INSTALL_ACTION,
          };
    const installation: AppStatusRowModel = input.installed
        ? {
              id: 'installation',
              label: 'PWA 설치 상태',
              status: 'ready',
              statusText: '설치됨',
              description: '현재 창은 홈 화면에 설치된 PWA로 실행 중입니다.',
              action: INSTALL_ACTION,
          }
        : input.installSupported
          ? {
                id: 'installation',
                label: 'PWA 설치 상태',
                status: 'attention',
                statusText: '설치되지 않음',
                description: '개인 기능과 푸시를 사용하려면 PWA를 설치해 주세요.',
                action: INSTALL_ACTION,
            }
          : {
                id: 'installation',
                label: 'PWA 설치 상태',
                status: 'attention',
                statusText: '설치되지 않음',
                description: '현재 창은 설치된 PWA가 아닌 일반 웹으로 실행 중입니다.',
                action: INSTALL_ACTION,
            };
    return [publicAccess, installSupport, installation];
}

export function appStatusRows(input: AppStatusInput, now = Date.now()): AppStatusRowModel[] {
    if (input.surface === 'desktop') return desktopRows(input);
    if (input.surface === 'pwa') return pwaRows(input, now);
    return webRows(input);
}
