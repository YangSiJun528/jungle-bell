import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardMealPost} from '@/dashboard-api';
import {WeeklyMealMenu} from './weekly-meal-menu';

describe('WeeklyMealMenu', () => {
    it('해당 주차 범위와 보관된 급식표 이미지를 함께 표시한다', () => {
        const sha = 'a'.repeat(64);
        const meal: DashboardMealPost = {
            id: 'weekly',
            title: '8월 2주차 식단표',
            text: '',
            publishedAt: '2026-08-10T00:00:00.000Z',
            permalink: 'https://pf.kakao.com/_xhzNjn/112664323',
            images: [{
                sha,
                url: `https://campus.example.com/api/public/assets/${sha}.jpg`,
                contentType: 'image/jpeg',
                extension: 'jpg',
                width: 1439,
                height: 1079,
                byteLength: 120_000,
            }],
        };

        const markup = renderToStaticMarkup(<WeeklyMealMenu meal={meal} weekKey="2026-08-10"/>);

        expect(markup).toContain('8월 2주차 식단표');
        expect(markup).toContain('8월 10일 ~ 8월 16일');
        expect(markup).toContain('<img');
        expect(markup).toContain('object-contain');
        expect(markup).toContain('<figure');
        expect(markup).toContain('<figcaption');
        expect(markup).toContain('요일별 급식 메뉴가 표로 정리된 상세 이미지');
        expect(markup).toContain('텍스트 형식의 상세 메뉴는 제공되지 않았습니다.');
        expect(markup).toContain('급식표 원문에서 전체 내용 확인');
    });

    it('서버가 구조화 가능한 텍스트를 제공하면 이미지와 함께 동등 내용을 노출한다', () => {
        const meal: DashboardMealPost = {
            id: 'weekly-text',
            title: '8월 2주차 식단표',
            text: '월요일 중식: 잡곡밥, 육개장',
            publishedAt: null,
            permalink: null,
            images: [],
        };

        const markup = renderToStaticMarkup(<WeeklyMealMenu meal={meal} weekKey="2026-08-10"/>);

        expect(markup).toContain('급식표 텍스트 내용');
        expect(markup).toContain('월요일 중식: 잡곡밥, 육개장');
    });
});
