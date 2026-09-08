import {readFileSync} from 'node:fs';

import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import type {DashboardMealPost} from '@/api/dashboard-api';

import {MealPostCard, MissingMealPostCard} from './meal-post-card';

const meal: DashboardMealPost = {
    id: 'lunch',
    title: '8월 11일(화) 중식 메뉴',
    text: '잡곡밥, 육개장',
    publishedAt: '2026-08-11T02:00:00.000Z',
    permalink: null,
    images: [
        {
            sha: 'a'.repeat(64),
            url: `https://jungle-bell.sijun-yang.com/api/public/assets/${'a'.repeat(64)}.jpg`,
            contentType: 'image/jpeg',
            extension: 'jpg',
            width: 1600,
            height: 1200,
            byteLength: 120_000,
        },
    ],
};

const source = readFileSync(new URL('./meal-post-card.tsx', import.meta.url), 'utf8');

describe('MealPostCard', () => {
    it('오늘 급식의 보관된 사진과 메뉴를 함께 표시한다', () => {
        const markup = renderToStaticMarkup(<MealPostCard meal={meal} eagerImage />);

        expect(markup).toContain('<img');
        expect(markup).toContain('loading="eager"');
        expect(markup).toContain('잡곡밥, 육개장');
        expect(markup).toContain('alt="8월 11일(화) 중식 메뉴 사진"');
        expect(markup).toContain(`href="${meal.images?.[0]?.url}"`);
        expect(markup).toContain('target="_blank"');
        expect(markup).toContain('rel="noopener noreferrer"');
        expect(markup).toContain('aria-label="8월 11일(화) 중식 메뉴 사진 새 탭에서 열기"');
        expect(markup).not.toContain('gradient');
        expect(markup).not.toContain('badge');
    });

    it('원문 링크의 실제 anchor에 접근 가능한 이름을 제공한다', () => {
        const markup = renderToStaticMarkup(
            <MealPostCard meal={{...meal, permalink: 'https://pf.kakao.com/_xhzNjn/112664323'}} />,
        );

        expect(markup).toMatch(/<a[^>]+aria-label="식단 원문 열기"/u);
        expect(markup).toContain('href="https://pf.kakao.com/_xhzNjn/112664323"');
    });

    it('사진이나 메뉴가 없으면 로딩 표시가 아닌 저채도 빈 상태로 구분한다', () => {
        const markup = renderToStaticMarkup(
            <MealPostCard meal={{...meal, images: [], text: ''}} />,
        );

        expect(markup).toContain('role="img"');
        expect(markup).toContain('aria-label="8월 11일(화) 중식 메뉴 사진 없음"');
        expect(markup).toContain('급식 사진이 아직 올라오지 않았습니다.');
        expect(markup).toContain('메뉴가 아직 올라오지 않았습니다.');
        expect(markup).toContain('bg-muted/60');
        expect(markup).toContain('text-muted-foreground');
        expect(markup.match(/text-base/gu)?.length).toBeGreaterThanOrEqual(2);
        expect(markup.match(/leading-6/gu)?.length).toBeGreaterThanOrEqual(2);
        expect(markup).not.toContain('animate-pulse');
    });

    it('텍스트가 이미지보다 먼저 렌더링되고 이미지에 펼치기/접기 토글이 존재한다', () => {
        const markup = renderToStaticMarkup(<MealPostCard meal={meal} />);
        const titleIndex = markup.indexOf('중식 메뉴');
        const imageContainerIndex = markup.indexOf('aria-label="8월 11일(화) 중식 메뉴 이미지"');

        expect(titleIndex).toBeGreaterThan(-1);
        expect(imageContainerIndex).toBeGreaterThan(titleIndex);
        expect(markup).toContain('aria-controls="lunch-image-preview"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('이미지 펼치기');
        expect(markup).toContain('class="mt-3 min-h-11 w-full"');
        expect(markup).toContain('max-h-44');
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).toContain('tabindex="-1"');
    });

    it('게시물 전체가 없으면 빈 상태를 한 번만 표시한다', () => {
        const markup = renderToStaticMarkup(<MissingMealPostCard period="석식" />);

        expect(markup).toContain('aria-label="석식 식단 게시 대기"');
        expect(markup).not.toContain('lucide-image-off');
        expect(markup).toContain('lucide-clock-3');
        expect(markup.match(/아직 올라오지 않았습니다\./gu)).toHaveLength(1);
        expect(markup).not.toContain('메뉴가 아직 올라오지 않았습니다.');
        expect(markup).not.toContain('data-slot="card-content"');
    });

    it('ImageOff는 실제 이미지 로드가 실패한 뒤에만 표시한다', () => {
        expect(source).toContain('onError={() => setFailed(true)}');
        expect(source).toMatch(/if \(failed\)[\s\S]*<ImageOff/u);
        expect(source).toMatch(/MissingMealPostCard[\s\S]*<Clock3/u);
    });
});
