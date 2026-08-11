import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {HomeMealSlots} from './home-view-model';
import {HomeMealSlotsList} from './home-meal-slots';

describe('HomeMealSlotsList', () => {
    it('keeps lunch above dinner and shows a visible empty state for a missing meal', () => {
        const slots: HomeMealSlots = [
            {
                period: '중식',
                meal: {
                    id: 'lunch',
                    title: '8월 11일 중식',
                    text: '비빔밥',
                    publishedAt: null,
                    permalink: null,
                },
            },
            {period: '석식', meal: null},
        ];

        const html = renderToStaticMarkup(<HomeMealSlotsList slots={slots}/>);

        expect(html.indexOf('data-meal-period="중식"'))
            .toBeLessThan(html.indexOf('data-meal-period="석식"'));
        expect(html).toContain('data-meal-empty="false"');
        expect(html).toContain('data-meal-empty="true"');
        expect(html).toContain('비빔밥');
        expect(html).toContain('아직 올라오지 않았습니다');
        expect(html).not.toContain('data-slot="skeleton"');
        expect(html).not.toContain('메뉴 준비 중');
    });

    it('does not render an empty state when both fixed slots have meals', () => {
        const slots: HomeMealSlots = [
            {
                period: '중식',
                meal: {
                    id: 'lunch', title: '8월 11일 중식', text: '점심',
                    publishedAt: null, permalink: null,
                },
            },
            {
                period: '석식',
                meal: {
                    id: 'dinner', title: '8월 11일 석식', text: '저녁',
                    publishedAt: null, permalink: null,
                },
            },
        ];

        const html = renderToStaticMarkup(<HomeMealSlotsList slots={slots}/>);

        expect(html).not.toContain('data-slot="skeleton"');
        expect(html).not.toContain('아직 올라오지 않았습니다');
    });
});
