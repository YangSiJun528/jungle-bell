import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import type {DashboardMealPost} from '@/api/dashboard-api';

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
            images: [
                {
                    sha,
                    url: `https://campus.example.com/api/public/assets/${sha}.jpg`,
                    contentType: 'image/jpeg',
                    extension: 'jpg',
                    width: 1439,
                    height: 1079,
                    byteLength: 120_000,
                },
            ],
        };

        const markup = renderToStaticMarkup(<WeeklyMealMenu meal={meal} weekKey="2026-08-10" />);

        expect(markup).toContain('8월 2주차 식단표');
        expect(markup).toContain('8월 10일 ~ 8월 16일');
        expect(markup).toContain('<img');
        expect(markup).toContain(`href="https://campus.example.com/api/public/assets/${sha}.jpg"`);
        expect(markup).toContain('target="_blank"');
        expect(markup).toContain('rel="noopener noreferrer"');
        expect(markup).toContain('aria-label="8월 2주차 식단표 급식표 새 탭에서 열기"');
        expect(markup).toContain('object-contain');
        expect(markup).toContain('8월 2주차 식단표, 8월 10일 ~ 8월 16일 급식표');
        expect(markup).not.toContain('<figcaption');
        expect(markup).not.toContain('data-text-alternative');
        expect(markup).not.toContain('role="status"');
        expect(markup).toContain('급식표 보러가기');
    });

    it('지난 기록의 선택 주 화면에서는 변경 가능한 원본 게시물 링크를 숨긴다', () => {
        const meal: DashboardMealPost = {
            id: 'weekly-history',
            title: '7월 4주차 식단표',
            text: '',
            publishedAt: '2026-07-20T00:00:00.000Z',
            updatedAt: null,
            permalink: 'https://pf.kakao.com/example/history',
            images: [],
        };

        const markup = renderToStaticMarkup(
            <WeeklyMealMenu meal={meal} showSourceLink={false} weekKey="2026-07-20" />,
        );

        expect(markup).not.toContain('급식표 보러가기');
        expect(markup).not.toContain(meal.permalink);
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

        const markup = renderToStaticMarkup(<WeeklyMealMenu meal={meal} weekKey="2026-08-10" />);

        expect(markup).toContain('급식표 텍스트 내용');
        expect(markup).toContain('월요일 중식: 잡곡밥, 육개장');
    });
});
