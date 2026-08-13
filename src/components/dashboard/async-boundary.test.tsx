import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
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
        const page = renderToStaticMarkup(<PageSkeleton/>);
        const meals = renderToStaticMarkup(<MealHistorySkeleton/>);

        expect(page).toContain('aria-label="화면을 불러오는 중"');
        expect(page).toContain('data-slot="skeleton"');
        expect(meals).toContain('aria-label="지난 급식 기록을 불러오는 중"');
        expect(meals).toContain('lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]');
    });
});
