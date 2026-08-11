import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {MealHistoryLoadMore} from './meal-history-load-more';

describe('MealHistoryLoadMore', () => {
    it('현재 표시할 기록이 없어도 다음 cursor가 있으면 과거 기록 CTA를 제공한다', () => {
        const markup = renderToStaticMarkup(
            <MealHistoryLoadMore loading={false} onLoad={() => undefined}/>,
        );

        expect(markup).toContain('<button');
        expect(markup).toContain('이전 기록 더 불러오기');
    });

    it('불러오는 동안 중복 요청을 막는다', () => {
        const markup = renderToStaticMarkup(
            <MealHistoryLoadMore loading onLoad={() => undefined}/>,
        );

        expect(markup).toContain('disabled');
        expect(markup).toContain('이전 기록 불러오는 중');
    });
});
