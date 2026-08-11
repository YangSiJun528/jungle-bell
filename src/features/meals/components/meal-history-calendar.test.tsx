import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {MealHistoryCalendar} from './meal-history-calendar';

const source = readFileSync(new URL('./meal-history-calendar.tsx', import.meta.url), 'utf8');

describe('MealHistoryCalendar', () => {
    it('급식이 있는 날짜와 선택한 날짜를 구분한다', () => {
        const markup = renderToStaticMarkup(
            <MealHistoryCalendar
                availableDates={new Set(['2026-08-10', '2026-08-11'])}
                selectedDate="2026-08-10"
                onSelect={() => undefined}
            />,
        );

        expect(markup).toContain('aria-label="2026년 8월 급식 기록 달력"');
        expect(markup).toContain('data-has-meal="true"');
        expect(markup).toContain('aria-pressed="true"');
        expect(markup).toContain('이전 달');
        expect(markup).toContain('다음 달');
    });

    it('선택 날짜는 초기 월에만 사용하고 월 이동 상태를 effect로 되돌리지 않는다', () => {
        expect(source).toContain('useState(() => selectedDate.slice(0, 7))');
        expect(source).not.toContain('useEffect');
    });
});
