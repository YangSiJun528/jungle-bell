import type {DesktopTestNotificationResult} from '@/api/dashboard-api';

export function desktopTestNotificationMessage(result: DesktopTestNotificationResult): string {
    if (result.systemDelivered && result.mobileQueued !== null) {
        return result.mobileQueued > 0
            ? `PC 운영체제에 표시를 요청했고, 연결된 모바일 ${result.mobileQueued}대의 테스트 푸시를 전송 대기열에 추가했습니다.`
            : 'PC 운영체제에 알림 표시를 요청했습니다. 연결된 모바일 푸시는 없습니다.';
    }
    if (result.systemDelivered)
        return 'PC 운영체제에 알림 표시를 요청했지만 모바일 테스트 전송은 확인하지 못했습니다.';
    if (result.mobileQueued !== null && result.mobileQueued > 0) {
        return `모바일 ${result.mobileQueued}대의 전송 대기열에는 추가했지만 PC 운영체제 알림은 실패했습니다.`;
    }
    return '알림함에는 추가했지만 운영체제 알림을 표시하지 못했습니다. 알림 권한을 확인하세요.';
}

export function mobilePushErrorMessage(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    const name = error instanceof Error ? error.name : '';
    if (code === 'PUSH_PERMISSION_DENIED' || name === 'NotAllowedError') {
        return '기기 또는 브라우저 설정에서 Jungle Bell 알림을 허용한 뒤 다시 시도하세요.';
    }
    if (code === 'PUSH_UNSUPPORTED') {
        return 'Web Push를 지원하는 브라우저에서 홈 화면에 설치한 PWA로 열어 주세요.';
    }
    if (code === 'PUSH_NOT_READY') {
        return '푸시 기능 준비가 끝나지 않았습니다. 잠시 후 다시 시도하세요.';
    }
    if (code === 'WEB_PUSH_NOT_CONFIGURED') {
        return '서버의 Web Push 설정이 완료되지 않았습니다.';
    }
    if (code === 'PUSH_TEST_NO_TARGETS' || code === 'PUSH_SUBSCRIPTION_REQUIRED') {
        return '테스트 알림을 전송할 기기가 없습니다. 푸시를 재등록한 뒤 다시 보내세요.';
    }
    if (code === 'AUTHENTICATION_REQUIRED' || code === 'SESSION_EXPIRED') {
        return 'PC 연결이 만료됐습니다. 기기를 다시 연결하세요.';
    }
    if (
        code === 'PUSH_REGISTRATION_STORAGE_UNAVAILABLE' ||
        code === 'PUSH_REGISTRATION_METADATA_READ_FAILED' ||
        code === 'PUSH_REGISTRATION_METADATA_WRITE_FAILED' ||
        code === 'PUSH_REGISTRATION_METADATA_CLEAR_FAILED'
    ) {
        return '이 기기에 푸시 등록 정보를 저장하지 못했습니다. 브라우저 저장 공간을 확인한 뒤 다시 시도하세요.';
    }
    if (code === 'PUSH_PREVIOUS_REGISTRATION_CLEANUP_FAILED') {
        return '이전 서버 등록을 정리하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.';
    }
    return '푸시 연결 중 오류가 발생했습니다. 네트워크를 확인하고 다시 시도하세요.';
}

export function assertMobileTestNotificationQueued(queued: number): number {
    if (!Number.isSafeInteger(queued) || queued <= 0) throw new Error('PUSH_TEST_NO_TARGETS');
    return queued;
}
