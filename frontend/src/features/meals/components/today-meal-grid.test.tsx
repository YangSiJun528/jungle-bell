import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import type {DashboardMealPost} from '@/api/dashboard-api';

import {TodayMealGrid} from './today-meal-grid';

const lunch: DashboardMealPost = {
    id: 'lunch',
    title: '8월 11일 중식',
    text: '잡곡밥, 육개장',
    publishedAt: '2026-08-11T02:00:00.000Z',
    permalink: null,
    images: [],
};

describe('TodayMealGrid', () => {
    it('중간 화면 크기부터 중식과 석식을 2열로 표시한다', () => {
        const markup = renderToStaticMarkup(<TodayMealGrid meals={[]} />);

        expect(markup).toContain('md:grid-cols-2');
        expect(markup).not.toContain('lg:grid-cols-2');
    });

    it('게시물이 없어도 중식과 석식 두 자리를 빈 상태로 유지한다', () => {
        const markup = renderToStaticMarkup(<TodayMealGrid meals={[]} />);

        expect(markup.match(/data-meal-state="missing"/gu)).toHaveLength(2);
        expect(markup).toContain('>중식<');
        expect(markup).toContain('>석식<');
        expect(markup).toContain('중식 식단 게시 대기');
        expect(markup).toContain('석식 식단 게시 대기');
        expect(markup).not.toContain('lucide-image-off');
        expect(markup).not.toContain('animate-pulse');
    });

    it('게시된 식사와 게시되지 않은 식사를 서로 다른 상태로 표시한다', () => {
        const markup = renderToStaticMarkup(<TodayMealGrid meals={[lunch]} />);

        expect(markup.match(/data-meal-state="available"/gu)).toHaveLength(1);
        expect(markup.match(/data-meal-state="missing"/gu)).toHaveLength(1);
        expect(markup).toContain('잡곡밥, 육개장');
        expect(markup).toContain('text-foreground/85');
        expect(markup).toContain('text-muted-foreground');
    });
});
