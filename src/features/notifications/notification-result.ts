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
