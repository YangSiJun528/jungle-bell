import type {DesktopConnectionState} from '@/api/dashboard-api';

export interface DesktopConnectionUiState {
    canCreatePairing: boolean;
    needsIdentityRecovery: boolean;
    label: string;
    reason: string | null;
}

export function desktopConnectionUiState(
    connection: DesktopConnectionState | undefined,
): DesktopConnectionUiState {
    if (!connection || connection.state === 'unknown') {
        return {
            canCreatePairing: false,
            needsIdentityRecovery: false,
            label: '확인 중',
            reason: null,
        };
    }
    if (connection.state === 'disconnected') {
        return {
            canCreatePairing: true,
            needsIdentityRecovery: false,
            label: '서버 등록 전',
            reason: '연결 코드를 만들면 이 PC를 서버에 자동으로 등록합니다.',
        };
    }
    if (connection.state === 'reset-required') {
        return {
            canCreatePairing: false,
            needsIdentityRecovery: true,
            label: '초기화 필요',
            reason: '이 PC에 저장된 인증 정보와 서버 등록이 일치하지 않습니다.',
        };
    }
    return {
        canCreatePairing: true,
        needsIdentityRecovery: false,
        label: connection.health === 'online' ? '온라인' : '연결됨',
        reason: null,
    };
}
