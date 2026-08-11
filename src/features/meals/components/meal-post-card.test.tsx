import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardMealPost} from '@/dashboard-api';
import {MealPostCard} from './meal-post-card';

const meal: DashboardMealPost = {
    id: 'lunch',
    title: '8월 11일(화) 중식 메뉴',
    text: '잡곡밥, 육개장',
    publishedAt: '2026-08-11T02:00:00.000Z',
    permalink: null,
    images: [{
        sha: 'a'.repeat(64),
        url: `https://campus.example.com/api/public/assets/${'a'.repeat(64)}.jpg`,
        contentType: 'image/jpeg',
        extension: 'jpg',
        width: 1600,
        height: 1200,
        byteLength: 120_000,
    }],
};

describe('MealPostCard', () => {
    it('오늘 급식의 보관된 사진과 메뉴를 함께 표시한다', () => {
        const markup = renderToStaticMarkup(<MealPostCard meal={meal} eagerImage/>);

        expect(markup).toContain('<img');
        expect(markup).toContain('loading="eager"');
        expect(markup).toContain('잡곡밥, 육개장');
        expect(markup).toContain('alt="8월 11일(화) 중식 메뉴 사진"');
        expect(markup).not.toContain('gradient');
        expect(markup).not.toContain('badge');
    });

    it('원문 링크의 실제 anchor에 접근 가능한 이름을 제공한다', () => {
        const markup = renderToStaticMarkup(
            <MealPostCard meal={{...meal, permalink: 'https://campus.example.com/meals/lunch'}}/>,
        );

        expect(markup).toMatch(/<a[^>]+aria-label="식단 원문 열기"/u);
        expect(markup).toContain('href="https://campus.example.com/meals/lunch"');
    });
});
