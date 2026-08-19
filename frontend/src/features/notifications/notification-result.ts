import type {DesktopTestNotificationResult} from '@/api/dashboard-api';

export function desktopTestNotificationMessage(result: DesktopTestNotificationResult): string {
    if (result.systemDelivered && result.mobileQueued !== null) {
        return result.mobileQueued > 0
            ? `PC와 연결된 모바일 ${result.mobileQueued}대에 테스트 알림을 보냈습니다.`
            : 'PC 운영체제 알림을 표시했습니다. 연결된 모바일 푸시는 없습니다.';
    }
    if (result.systemDelivered) return 'PC 알림은 표시했지만 모바일 테스트 전송은 확인하지 못했습니다.';
    if (result.mobileQueued !== null && result.mobileQueued > 0) {
        return `모바일 ${result.mobileQueued}대에는 보냈지만 PC 운영체제 알림은 실패했습니다.`;
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
    if (code === 'WEB_PUSH_NOT_CONFIGURED') {
        return '서버의 Web Push 설정이 완료되지 않았습니다.';
    }
    if (code === 'AUTHENTICATION_REQUIRED' || code === 'SESSION_EXPIRED') {
        return 'PC 연결이 만료됐습니다. 기기를 다시 연결하세요.';
    }
    return '푸시 연결 중 오류가 발생했습니다. 네트워크를 확인하고 다시 시도하세요.';
}
