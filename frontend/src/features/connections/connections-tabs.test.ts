import {describe, expect, test} from 'vitest';

import {
    connectionsTabFromHash,
    connectionsTabHref,
    parseConnectionsTabSearch,
    type ConnectionsTab,
} from './connections-tabs';

describe('connections tab search state', () => {
    test.each<ConnectionsTab>(['status', 'notifications', 'services', 'devices'])(
        '%s 탭을 URL search에서 복원한다',
        (tab) => {
            expect(parseConnectionsTabSearch({tab})).toBe(tab);
            expect(connectionsTabFromHash(`#/connections?tab=${tab}`)).toBe(tab);
        },
    );

    test('기기 연결 패널로 바로 가는 공개 href를 만든다', () => {
        expect(connectionsTabHref('devices')).toBe('#/connections?tab=devices');
    });

    test('없거나 알 수 없는 값은 기존 알림 설정 탭으로 안전하게 보낸다', () => {
        expect(parseConnectionsTabSearch({})).toBe('notifications');
        expect(parseConnectionsTabSearch({tab: 'unknown'})).toBe('notifications');
        expect(parseConnectionsTabSearch({tab: ['devices']})).toBe('notifications');
        expect(connectionsTabFromHash('#/connections?tab=%')).toBe('notifications');
    });
});
