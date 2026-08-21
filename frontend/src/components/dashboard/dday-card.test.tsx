import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {buildDdayProgress} from '@/domain/attendance/dday-progress';
import type {DdayView} from '@/domain/attendance/dday-view';

import {DdayCard} from './dday-card';

const period = {startDate: '2026-01-29', endDate: '2026-03-02'};
const progress = buildDdayProgress(period, '2026-02-02');
if (!progress) throw new Error('TEST_DDAY_PROGRESS_REQUIRED');

const view: DdayView = {
    text: '수료까지 D-28',
    period,
    progress,
};

describe('DdayCard', () => {
    it('renders a collapsed full-card trigger with the compact progress summary', () => {
        const markup = renderToStaticMarkup(createElement(DdayCard, {view}));

        expect(markup).toContain('data-dday-card="true"');
        expect(markup).toContain('수료까지 D-28');
        expect(markup).toContain('12.1%');
        expect(markup).toMatch(/완료 <strong[^>]*>4<\/strong>일/u);
        expect(markup).toMatch(/남음 <strong[^>]*>28<\/strong>일/u);
        expect(markup).toContain('2026.1.29 – 2026.3.2');
        expect(markup).toContain('role="progressbar"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('aria-controls=');
        expect(markup).toContain('과정 달력 펼치기');
        expect(markup).not.toContain('role="img"');
    });

    it('renders the month-by-31-day matrix and accessible aggregate when expanded', () => {
        const markup = renderToStaticMarkup(createElement(DdayCard, {view, defaultOpen: true}));

        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('과정 달력 접기');
        expect(markup).toContain('role="img"');
        expect(markup).toContain(
            'aria-label="코스 진행률 12.1%, 완료 4일, 오늘 진행 중, 남음 28일"',
        );
        expect(markup.match(/data-dday-cell="true"/gu)).toHaveLength(93);
        expect(markup.match(/data-dday-day-axis="true"/gu)).toHaveLength(31);
        expect(markup).toContain('>1</span>');
        expect(markup).toContain('>10</span>');
        expect(markup).toContain('>20</span>');
        expect(markup).toContain('>31</span>');
        expect(markup).toContain('1월');
        expect(markup).toContain('2월');
        expect(markup).toContain('3월');
        expect(markup).toContain('title="2026년 2월 2일 · 오늘"');
        expect(markup).toContain('data-dday-state="elapsed"');
        expect(markup).toContain('data-dday-state="current"');
        expect(markup).toContain('data-dday-state="remaining"');
    });

    it('keeps a text-only state visible but disables expansion', () => {
        const markup = renderToStaticMarkup(
            createElement(DdayCard, {
                view: {text: '수료일 정보 없음', period: null, progress: null},
            }),
        );

        expect(markup).toContain('수료일 정보 없음');
        expect(markup).toContain('disabled=""');
        expect(markup).toContain('세부 과정 기간이 확인되면 진행률과 전체 달력을 표시합니다.');
        expect(markup).not.toContain('role="progressbar"');
        expect(markup).not.toContain('role="img"');
    });
});
