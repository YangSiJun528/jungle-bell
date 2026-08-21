import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {PersonalFeatureSlot} from './personal-feature-slot';

const state = vi.hoisted(() => ({status: 'unconnected'}));

vi.mock('./dashboard-account', () => ({
    useDashboardAccount: () => ({personalAccess: {status: state.status}}),
}));

describe('PersonalFeatureSlot', () => {
    test('미연결 웹에서는 embedded 개인 subtree를 실행하지 않는다', () => {
        let renders = 0;
        const PersonalQueryOwner = () => {
            renders += 1;
            return <p>개인 세탁 알림</p>;
        };

        state.status = 'unconnected';
        const hidden = renderToStaticMarkup(
            <PersonalFeatureSlot>
                <PersonalQueryOwner />
            </PersonalFeatureSlot>,
        );
        expect(hidden).toBe('');
        expect(renders).toBe(0);

        state.status = 'connected';
        const visible = renderToStaticMarkup(
            <PersonalFeatureSlot>
                <PersonalQueryOwner />
            </PersonalFeatureSlot>,
        );
        expect(visible).toContain('개인 세탁 알림');
        expect(renders).toBe(1);
    });
});
