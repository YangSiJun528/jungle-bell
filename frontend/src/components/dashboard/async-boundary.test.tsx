import {readFileSync} from 'node:fs';

import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {AsyncBoundary} from './async-boundary';
import {MealHistorySkeleton, PageSkeleton} from './async-state';

const source = readFileSync(new URL('./async-boundary.tsx', import.meta.url), 'utf8');

describe('AsyncBoundary', () => {
    it('query reset, ErrorBoundary, Suspense를 한 선언적 경계로 구성한다', () => {
        expect(source).toContain('<QueryErrorResetBoundary>');
        expect(source).toContain('<ErrorBoundary');
        expect(source).toContain('<Suspense fallback={fallback}>');
        expect(source).toContain('retry={resetErrorBoundary}');
        expect(source).toContain('onReset={reset}');
    });

    it('화면과 월별 급식 기록의 레이아웃 스켈레톤을 제공한다', () => {
        const page = renderToStaticMarkup(<PageSkeleton />);
        const meals = renderToStaticMarkup(<MealHistorySkeleton />);

        expect(page).toContain('aria-label="화면을 불러오는 중"');
        expect(page).toContain('data-slot="skeleton"');
        expect(meals).toContain('aria-label="지난 급식 기록을 불러오는 중"');
        expect(meals).toContain('lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]');
    });

    it('header prop으로 이름 붙은 지역(role=region)을 제공한다', () => {
        const markup = renderToStaticMarkup(
            <AsyncBoundary header="대시보드 섹션">
                <div>로딩 콘텐츠</div>
            </AsyncBoundary>,
        );

        expect(markup).toContain('role="region"');
        expect(markup).toContain('aria-label="대시보드 섹션"');
    });

    it('외부 헤더 id를 사용해 지역 라벨링이 가능하다', () => {
        const markup = renderToStaticMarkup(
            <AsyncBoundary regionLabelledBy="dashboard-heading">
                <h2 id="dashboard-heading">대시보드 헤더</h2>
                <div>로딩 콘텐츠</div>
            </AsyncBoundary>,
        );

        expect(markup).toContain('role="region"');
        expect(markup).toContain('aria-labelledby="dashboard-heading"');
    });
});
