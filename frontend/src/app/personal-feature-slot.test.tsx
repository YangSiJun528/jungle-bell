import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {personalFeatureAvailable, PersonalFeatureSlot} from './personal-feature-slot';

const state = vi.hoisted(() => ({status: 'unconnected'}));

vi.mock('./dashboard-account', () => ({
    useDashboardAccount: () => ({personalAccess: {status: state.status}}),
}));

describe('PersonalFeatureSlot', () => {
    test.each(['not-applicable', 'checking', 'unconnected', 'error'] as const)(
        '%s 상태는 개인 subtree를 사용할 수 없다',
        (status) => {
            expect(personalFeatureAvailable({status})).toBe(false);
        },
    );

    test('connected 상태만 개인 subtree를 사용할 수 있다', () => {
        expect(personalFeatureAvailable({status: 'connected'})).toBe(true);
    });

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
