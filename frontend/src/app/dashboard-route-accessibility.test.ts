import {describe, expect, it, vi} from 'vitest';

import {
    dashboardDocumentTitle,
    dashboardHeadingLabel,
    focusDashboardHeading,
} from './dashboard-route-accessibility-utils';

describe('dashboard route accessibility', () => {
    it.each([
        ['/home', '홈 · Jungle Bell'],
        ['/meals', '급식 · Jungle Bell'],
        ['/privacy', '개인정보 처리방침 · Jungle Bell'],
    ])('%s의 문서 제목을 route와 일치시킨다', (pathname, title) => {
        expect(dashboardDocumentTitle(pathname)).toBe(title);
    });

    it.each([
        ['/home', '홈'],
        ['/meals', '급식'],
        ['/privacy', '개인정보 처리방침'],
    ])('%s의 포커스 대상 H1을 route와 일치시킨다', (pathname, heading) => {
        expect(dashboardHeadingLabel(pathname)).toBe(heading);
    });

    it('route H1을 프로그래밍 방식으로 포커스 가능하게 만들고 이동한다', () => {
        const heading = {tabIndex: 0, focus: vi.fn<() => void>()};
        const staleHeading = {textContent: '홈', tabIndex: 0, focus: vi.fn<() => void>()};
        const currentHeading = {
            textContent: '급식',
            tabIndex: 0,
            focus: vi.fn<() => void>(),
        };
        const documentObject = {
            querySelectorAll: vi.fn<() => (typeof heading)[]>(() => [staleHeading, currentHeading]),
        } as unknown as Document;

        expect(focusDashboardHeading(documentObject, '급식')).toBe(true);
        expect(staleHeading.focus).not.toHaveBeenCalled();
        expect(currentHeading.tabIndex).toBe(-1);
        expect(currentHeading.focus).toHaveBeenCalledWith({preventScroll: true});
    });
});
