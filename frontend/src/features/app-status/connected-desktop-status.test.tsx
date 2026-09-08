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
});
