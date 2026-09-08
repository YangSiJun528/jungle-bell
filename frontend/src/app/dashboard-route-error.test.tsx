import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';

import {DashboardRouteErrorFallback} from './dashboard-route-error';

describe('DashboardRouteErrorFallback', () => {
    it('현재 route 제목을 H1으로 유지하고 복구 동작을 제공한다', () => {
        const markup = renderToStaticMarkup(
            <DashboardRouteErrorFallback route="meals" retry={vi.fn<() => void>()} />,
        );

        expect(markup).toContain('<h1');
        expect(markup).toContain('식단');
        expect(markup).toContain('식단 화면을 불러오지 못했습니다.');
        expect(markup).toContain('새로고침');
    });
});
