import type {LmsAuthenticationStatus, ServerSessionStatus} from '@/app/dashboard-account-state';
import type {ConnectionsTab} from '@/app/routes';
import {dateTimeLabel} from '@/lib/format';
import type {NotificationTestRecord} from '@/platform/notification-test-history';
import type {AuthenticationState, PushState} from '@/platform/status-model';

import type {
    AppNotificationPermission,
    DesktopUpdateObservation,
    ServiceWorkerObservation,
} from './app-status-observations';

export type AppStatusValue = 'attention' | 'checking' | 'error' | 'ready' | 'unavailable';

export type AppStatusTab = ConnectionsTab;

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
    osNotification: NotificationTestRecord | 'checking' | 'error' | null;
    update: DesktopUpdateObservation;
}

export type PwaPushLifecycleStatus =
    | 'checking'
    | 'error'
    | 'matched-registered'
    | 'matched-registration-unverified'
    | 'matched-server-removed'
    | 'local-only'
    | 'record-only'
    | 'mismatch'
    | 'none'
    | 'invalid'
    | 'failed';

export interface PwaPushLifecycleObservation {
    status: PwaPushLifecycleStatus;
    subscriptionId?: string;
    serverEvidence?: 'registration-response';
}

export interface PwaAppStatusInput {
    surface: 'pwa';
    authentication: AuthenticationState;
    sessionExpiresAt: ObservableValue<string | null>;
    notificationPermission: AppNotificationPermission;
    pushState: PushState;
    pushLifecycle: PwaPushLifecycleObservation;
    lastTest: NotificationTestRecord | 'checking' | 'error' | null;
    serviceWorker: ServiceWorkerObservation | 'checking';
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

function desktopNotificationRow(value: DesktopAppStatusInput['osNotification']): AppStatusRowModel {
    const base = {
        id: 'os-notification',
        label: '운영체제 알림 표시',
        action: NOTIFICATION_ACTION,
    };
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '이 PC에 저장된 마지막 알림 테스트 결과를 확인하고 있습니다.',
        };
    }
    if (value === 'error') {
        return {
            ...base,
            status: 'error',
            statusText: '확인 실패',
            description: '알림 테스트 기록을 읽지 못했습니다. 알림 설정에서 다시 테스트해 주세요.',
        };
    }
    if (value === null) {
        return {
            ...base,
            status: 'attention',
            statusText: '테스트 기록 없음',
            description: '알림 설정에서 PC 테스트 알림을 보내고 실제 표시 여부를 확인해 주세요.',
        };
    }
    const testedAt = dateTimeLabel(value.testedAt);
    if (value.state.status === 'test-sending') {
        return {
            ...base,
            status: 'checking',
            statusText: '표시 확인 대기',
            description: `${testedAt}에 테스트를 보냈습니다. 실제 표시 여부를 알림 설정에서 확인해 주세요.`,
        };
    }
    if (value.state.status === 'arrived') {
        return {
            ...base,
            status: 'ready',
            statusText: '실제 표시 확인',
            description: `${testedAt}에 사용자가 PC 테스트 알림 표시를 확인했습니다.`,
        };
    }
    return {
        ...base,
        status: 'error',
        statusText: value.state.status === 'not-arrived' ? '표시되지 않음' : '테스트 실패',
        description: `${testedAt}의 PC 알림 테스트를 완료하지 못했습니다. 알림 설정과 운영체제 설정을 확인해 주세요.`,
    };
}

function desktopUpdateRow(value: DesktopUpdateObservation): AppStatusRowModel {
    const action: AppStatusAction = {
        href: '#/connections?tab=services',
        label: '앱 업데이트 열기',
        tab: 'services',
    };
    const base = {id: 'update', label: 'PC 앱 업데이트', action};
    if (!value.state && value.queryStatus === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '업데이트 상태를 확인하고 있습니다.',
        };
    }
    if (!value.state && value.queryStatus === 'error') {
        return {
            ...base,
            status: 'error',
            statusText: '확인 실패',
            description: '네트워크를 확인한 뒤 업데이트 화면에서 다시 시도해 주세요.',
        };
    }
    if (!value.state) return unavailableRow(base.id, base.label, base.action);
    const checkedAt = value.checkedAt ? dateTimeLabel(value.checkedAt) : null;
    const update = value.state;
    if (value.queryStatus === 'error') {
        return {
            ...base,
            status: 'error',
            statusText:
                update.policy === 'mandatory' ? '필수 업데이트 · 재확인 실패' : '재확인 실패',
            description:
                update.policy === 'mandatory'
                    ? `${update.availableVersion ?? '새 버전'} 필수 업데이트 상태는 유지됩니다. 네트워크를 확인하고 다시 확인해 주세요.`
                    : `마지막 업데이트 상태${checkedAt ? `(${checkedAt})` : ''} 이후 재확인에 실패했습니다.`,
        };
    }
    if (value.queryStatus === 'stale') {
        return {
            ...base,
            status: 'attention',
            statusText: '상태 재확인 필요',
            description: `마지막 확인 상태${checkedAt ? `(${checkedAt})` : ''}가 오래됐습니다. 업데이트를 다시 확인해 주세요.`,
        };
    }
    switch (update.status) {
        case 'checking':
            return {
                ...base,
                status: 'checking',
                statusText: '확인 중',
                description: '업데이트 상태를 확인하고 있습니다.',
            };
        case 'latest':
            return {
                ...base,
                status: 'ready',
                statusText: `최신 버전 · v${update.currentVersion}`,
                description: checkedAt
                    ? `${checkedAt}에 업데이트를 확인했습니다.`
                    : '사용 가능한 업데이트가 없습니다.',
            };
        case 'optional':
        case 'mandatory':
            return {
                ...base,
                status: 'attention',
                statusText: `${update.availableVersion ?? '새 버전'} 업데이트 가능`,
                description:
                    update.policy === 'mandatory'
                        ? '계속 사용하려면 최신 정식 버전을 설치해야 합니다.'
                        : `새 버전을 설치할 수 있습니다${checkedAt ? ` · ${checkedAt} 확인` : ''}.`,
            };
        case 'downloading': {
            const progress = update.progress;
            const percentage =
                progress?.totalBytes && progress.totalBytes > 0
                    ? ` ${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}%`
                    : '';
            return {
                ...base,
                status: 'checking',
                statusText: `다운로드 중${percentage}`,
                description: '업데이트 파일을 안전하게 내려받고 있습니다.',
            };
        }
        case 'verifying':
            return {
                ...base,
                status: 'checking',
                statusText: '서명 검증 중',
                description: '다운로드한 업데이트의 서명을 검증하고 있습니다.',
            };
        case 'installing':
            return {
                ...base,
                status: 'checking',
                statusText: '설치 중',
                description: '검증한 업데이트를 설치하고 있습니다.',
            };
        case 'restart-required':
            return {
                ...base,
                status: 'attention',
                statusText: '재시작 필요',
                description: '업데이트 적용을 마치려면 PC 앱을 재시작해야 합니다.',
            };
        case 'failed':
            return {
                ...base,
                status: 'error',
                statusText: '업데이트 실패',
                description: `업데이트를 완료하지 못했습니다${update.errorCode ? ` · ${update.errorCode}` : ''}.`,
            };
    }
    return unavailableRow(base.id, base.label, base.action);
}

function desktopRows(input: DesktopAppStatusInput): AppStatusRowModel[] {
    return [
        lmsAuthenticationRow(input.lmsAuthentication),
        serverCredentialRow(input.serverSession),
        lastSyncRow(input.lastSyncedAt),
        mobileSessionsRow(input.mobileSessionCount),
        desktopNotificationRow(input.osNotification),
        desktopUpdateRow(input.update),
    ];
}

function personalAccessRow(value: AuthenticationState): AppStatusRowModel {
    const base = {id: 'personal-access', label: 'PC 계정 연결', action: DEVICE_ACTION};
    if (value.status === 'authenticated') {
        return {
            ...base,
            status: 'ready',
            statusText: '연결됨',
            description: '이 PWA가 개인 기능을 사용할 수 있습니다.',
        };
    }
    if (value.status === 'checking' || value.status === 'recovering') {
        return {
            ...base,
            status: 'checking',
            statusText: value.status === 'recovering' ? '복구 중' : '확인 중',
            description:
                value.status === 'recovering'
                    ? '마지막 연결 정보를 유지한 채 현재 모바일 세션을 다시 확인하고 있습니다.'
                    : '현재 모바일 세션을 확인하고 있습니다.',
        };
    }
    if (value.status === 'first-connect' || value.status === 'expired') {
        return {
            ...base,
            status: 'attention',
            statusText: value.status === 'expired' ? '세션 만료' : '연결 필요',
            description:
                value.status === 'expired'
                    ? 'PC 앱에서 새 연결 코드를 만들어 이 PWA를 다시 연결해 주세요.'
                    : 'PC 앱에서 새 연결 코드를 만들어 이 PWA를 연결해 주세요.',
        };
    }
    return {
        ...base,
        status: 'error',
        statusText: value.status === 'offline' ? '오프라인' : '확인 실패',
        description:
            value.status === 'offline'
                ? '네트워크 연결을 복구한 뒤 기기 연결 상태를 다시 확인해 주세요.'
                : '서버 상태를 확인한 뒤 기기 연결 화면에서 다시 시도해 주세요.',
    };
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
    return {
        ...base,
        status: 'error',
        statusText: '지원되지 않음',
        description: '현재 브라우저에서는 운영체제 푸시 알림 권한을 사용할 수 없습니다.',
    };
}

function localPushRow(input: PwaAppStatusInput): AppStatusRowModel {
    const base = {id: 'local-push', label: '로컬 푸시 구독', action: NOTIFICATION_ACTION};
    const status = input.pushLifecycle.status;
    if (status === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '현재 브라우저의 로컬 푸시 구독을 확인하고 있습니다.',
        };
    }
    if (
        status === 'matched-registered' ||
        status === 'matched-registration-unverified' ||
        status === 'matched-server-removed' ||
        status === 'local-only'
    ) {
        const serverVerified =
            status === 'matched-registered' &&
            input.pushLifecycle.serverEvidence === 'registration-response';
        return {
            ...base,
            status: serverVerified ? 'ready' : 'attention',
            statusText: '구독됨',
            description: serverVerified
                ? '현재 브라우저의 로컬 구독이 저장된 서버 등록과 일치합니다.'
                : '로컬 구독은 남아 있지만 서버 등록을 다시 확인해야 합니다.',
        };
    }
    if (status === 'none' || status === 'record-only') {
        return {
            ...base,
            status: 'attention',
            statusText: '구독 없음',
            description: '알림 설정에서 이 기기의 푸시를 연결하거나 재등록해 주세요.',
        };
    }
    return {
        ...base,
        status: 'error',
        statusText: input.pushState.status === 'unsupported' ? '지원되지 않음' : '복구 필요',
        description: '로컬 구독과 저장된 등록 정보를 대조하지 못했습니다. 푸시를 재등록해 주세요.',
    };
}

function serverRegistrationRow(input: PwaAppStatusInput): AppStatusRowModel {
    const base = {
        id: 'server-registration',
        label: '서버 푸시 등록',
        action: NOTIFICATION_ACTION,
    };
    const status = input.pushLifecycle.status;
    if (status === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '저장된 서버 등록 ID와 로컬 구독을 대조하고 있습니다.',
        };
    }
    if (
        status === 'matched-registered' &&
        input.pushLifecycle.subscriptionId &&
        input.pushLifecycle.serverEvidence === 'registration-response'
    ) {
        return {
            ...base,
            status: 'ready',
            statusText: `등록됨 · ${input.pushLifecycle.subscriptionId.slice(-8)}`,
            description: '이 기기의 로컬 구독이 이번 서버 등록 응답과 일치합니다.',
        };
    }
    if (status === 'matched-registration-unverified' || status === 'matched-registered') {
        return {
            ...base,
            status: 'attention',
            statusText: '서버 확인 필요',
            description:
                '저장된 등록 ID와 로컬 구독은 일치하지만 현재 서버 등록은 확인되지 않았습니다. 푸시를 재등록해 주세요.',
        };
    }
    if (status === 'matched-server-removed') {
        return {
            ...base,
            status: 'attention',
            statusText: '서버 해제됨',
            description: '서버 등록 제거는 끝났지만 로컬 구독 정리가 남았습니다.',
        };
    }
    if (status === 'local-only' || status === 'none') {
        return {
            ...base,
            status: 'attention',
            statusText: '등록 없음',
            description: '알림 설정에서 현재 구독을 서버에 등록해 주세요.',
        };
    }
    if (status === 'record-only') {
        return {
            ...base,
            status: 'attention',
            statusText: '저장 기록만 있음',
            description:
                '저장된 서버 등록 ID는 있지만 현재 로컬 구독이 없습니다. 푸시를 정리하거나 재등록해 주세요.',
        };
    }
    return {
        ...base,
        status: 'error',
        statusText: status === 'mismatch' ? '구독 불일치' : '확인 실패',
        description: '서버 등록과 현재 로컬 구독을 확인하지 못했습니다. 푸시를 재등록해 주세요.',
    };
}

function lastTestRow(value: PwaAppStatusInput['lastTest']): AppStatusRowModel {
    const base = {id: 'last-test', label: '마지막 테스트 알림', action: NOTIFICATION_ACTION};
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '이 기기에 저장된 마지막 테스트 결과를 확인하고 있습니다.',
        };
    }
    if (value === 'error') {
        return {
            ...base,
            status: 'error',
            statusText: '확인 실패',
            description:
                '마지막 테스트 기록을 읽지 못했습니다. 알림 설정에서 테스트를 다시 실행해 주세요.',
        };
    }
    if (value === null) {
        return {
            ...base,
            status: 'attention',
            statusText: '테스트 기록 없음',
            description: '알림 설정에서 테스트 푸시를 보내고 실제 도착 여부를 확인해 주세요.',
        };
    }
    const testedAt = dateTimeLabel(value.testedAt);
    if (value.state.status === 'arrived') {
        return {
            ...base,
            status: 'ready',
            statusText: '실제 도착 확인',
            description: `${testedAt}에 사용자가 테스트 푸시 도착을 확인했습니다.`,
        };
    }
    if (value.state.status === 'test-sending') {
        return {
            ...base,
            status: 'checking',
            statusText: '도착 확인 대기',
            description: `${testedAt}에 테스트를 보냈습니다. 실제 도착 여부를 알림 설정에서 확인해 주세요.`,
        };
    }
    return {
        ...base,
        status: 'error',
        statusText: value.state.status === 'not-arrived' ? '도착하지 않음' : '테스트 실패',
        description: `${testedAt}의 테스트가 완료되지 않았습니다. 알림 설정에서 다시 보내거나 재등록해 주세요.`,
    };
}

function serviceWorkerRow(value: PwaAppStatusInput['serviceWorker']): AppStatusRowModel {
    const base = {id: 'service-worker', label: '서비스 워커', action: NOTIFICATION_ACTION};
    if (value === 'checking') {
        return {
            ...base,
            status: 'checking',
            statusText: '확인 중',
            description: '현재 PWA의 서비스 워커 등록을 확인하고 있습니다.',
        };
    }
    if (value.status === 'active') {
        return {
            ...base,
            status: 'ready',
            statusText: `v${value.version} 활성`,
            description: '현재 PWA 빌드의 서비스 워커가 활성화되어 있습니다.',
        };
    }
    if (value.status === 'installing' || value.status === 'waiting') {
        return {
            ...base,
            status: 'checking',
            statusText: value.status === 'waiting' ? '업데이트 대기' : '설치 중',
            description: `서비스 워커 v${value.version} 상태를 적용하고 있습니다.`,
        };
    }
    return {
        ...base,
        status: value.status === 'missing' ? 'attention' : 'error',
        statusText: value.status === 'missing' ? '등록 없음' : '확인 실패',
        description:
            '서비스 워커를 확인하지 못했습니다. 알림 설정에서 푸시 준비를 다시 시도해 주세요.',
    };
}

function pwaRows(input: PwaAppStatusInput, now: number): AppStatusRowModel[] {
    return [
        personalAccessRow(input.authentication),
        sessionExpiryRow(input.sessionExpiresAt, now),
        notificationPermissionRow(input.notificationPermission),
        localPushRow(input),
        serverRegistrationRow(input),
        lastTestRow(input.lastTest),
        serviceWorkerRow(input.serviceWorker),
    ];
}

function webRows(input: WebAppStatusInput): AppStatusRowModel[] {
    const publicAccess: AppStatusRowModel = {
        id: 'public-access',
        label: '공개 기능',
        status: 'ready',
        statusText: '사용 가능',
        description: '설치나 계정 연결 없이 공개 세탁실·급식 정보를 사용할 수 있습니다.',
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

export function appStatusWarningCount(rows: readonly Pick<AppStatusRowModel, 'status'>[]): number {
    return rows.filter(({status}) => status === 'attention' || status === 'error').length;
}
