import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./connected-desktop-status.tsx', import.meta.url), 'utf8');

describe('ConnectedDesktopStatus', () => {
    test('surface=pc 알림 테스트 기록을 공용 query에서 재수화한다', () => {
        expect(source).toContain('NOTIFICATION_TEST_QUERY_KEY');
        expect(source).toContain('readNotificationTestRecord');
        expect(source).toContain("notificationTest.data?.surface === 'pc'");
        expect(source).toContain('osNotification:');
    });

    test('producer 실패를 경고하고 실패한 상태 재조회 동작을 제공한다', () => {
        expect(source).toContain('failedDesktopStatusProducers([');
        expect(source).toContain('<DesktopStatusRefreshFailure failures={failures} />');
        expect(source).toContain('일부 앱 상태를 다시 확인하지 못했습니다.');
        expect(source).toContain('실패한 상태 다시 확인');
        expect(source).toContain('retryFailedDesktopStatusProducers(failures)');
    });
});
