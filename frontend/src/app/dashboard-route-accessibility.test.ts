import {describe, expect, it, vi} from 'vitest';

import {dashboardDocumentTitle, focusDashboardHeading} from './dashboard-route-accessibility-utils';

describe('dashboard route accessibility', () => {
    it.each([
        ['/home', '홈 · Jungle Bell'],
        ['/meals', '급식 · Jungle Bell'],
        ['/privacy', '개인정보 처리방침 · Jungle Bell'],
    ])('%s의 문서 제목을 route와 일치시킨다', (pathname, title) => {
        expect(dashboardDocumentTitle(pathname)).toBe(title);
    });

    it('route H1을 프로그래밍 방식으로 포커스 가능하게 만들고 이동한다', () => {
        const heading = {tabIndex: 0, focus: vi.fn<() => void>()};
        const documentObject = {
            querySelector: vi.fn<() => typeof heading>(() => heading),
        } as unknown as Document;

        expect(focusDashboardHeading(documentObject)).toBe(true);
        expect(heading.tabIndex).toBe(-1);
        expect(heading.focus).toHaveBeenCalledWith({preventScroll: true});
    });
});
