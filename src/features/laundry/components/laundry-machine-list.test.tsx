import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardLaundryMachine} from '@/dashboard-model';
import {LaundryMachineList} from './laundry-machine-list';

const NOW_MS = Date.parse('2026-08-11T03:00:00.000Z');

const machines: DashboardLaundryMachine[] = [{
    id: '워시타워_2',
    zone: 'men',
    washer: {
        appliance: 'washer',
        operationalStatus: 'RUNNING',
        state: {code: 'RINSING'},
        totalMinutes: 60,
        startedAt: '2026-08-11T02:30:00.000Z',
        estimatedFinishAt: '2026-08-11T03:30:00.000Z',
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 35, estimated: true},
    },
    dryer: {
        appliance: 'dryer',
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    },
}, {
    id: '워시타워_1',
    zone: 'men',
    washer: null,
    dryer: {
        appliance: 'dryer',
        operationalStatus: 'ERROR',
        errorCode: 'EMPTY_WATER_ALERT_ERROR',
        projection: {status: 'ERROR'},
    },
}];

describe('LaundryMachineList', () => {
    it('번호순 워시타워 목록에 세탁기와 건조기 상세 상태를 표시한다', () => {
        const markup = renderToStaticMarkup(
            <LaundryMachineList machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('기기별 상세 상태');
        expect(markup.indexOf('1번 워시타워')).toBeLessThan(markup.indexOf('2번 워시타워'));
        expect(markup.indexOf('>건조기<')).toBeLessThan(markup.indexOf('>세탁기<'));
        expect(markup).toContain('세탁기');
        expect(markup).toContain('건조기');
        expect(markup).toContain('헹굼 중 · 예상');
        expect(markup).toContain('약 30분 남음');
        expect(markup).toContain('전체 60분');
        expect(markup).toContain('사용 가능');
        expect(markup).toContain('배관 에러');
        expect(markup).toContain('aria-label="1번 워시타워 건조기 상세 안내"');
        expect(markup).not.toContain('EMPTY_WATER_ALERT_ERROR');
    });

    it('진행률과 시간 정보를 접근 가능한 이름으로 제공한다', () => {
        const markup = renderToStaticMarkup(
            <LaundryMachineList machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('role="progressbar"');
        expect(markup).toContain('aria-label="2번 워시타워 세탁 진행률"');
        expect(markup).toContain('aria-valuenow="50"');
        expect(markup).toContain('aria-label="2번 워시타워 세탁기 상세 안내"');
        expect(markup).not.toContain('>예상 진행률 50%</p>');
        expect(markup).toContain('aria-valuetext="예상 50% 진행, 약 30분 남음, 전체 60분"');
        expect(markup).toContain('aria-valuetext="오류로 진행률을 확인할 수 없음"');
        expect(markup).toContain('11:30 시작');
        expect(markup).toContain('12:30 예상 종료');
    });

    it('상세 목록은 가로 최소 너비를 강제하지 않고 반응형 열로 배치한다', () => {
        const markup = renderToStaticMarkup(
            <LaundryMachineList machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('data-laundry-detail-list="true"');
        expect(markup).toContain('data-laundry-machine-card="true"');
        expect(markup).toContain('<h3 class="text-base font-semibold leading-none">1번 워시타워</h3>');
        expect(markup).toContain('auto-rows-fr');
        expect(markup).toContain('md:grid-cols-2');
        expect(markup).toContain('grid flex-1 grid-rows-2');
        expect(markup).toContain('data-kind="dryer"');
        expect(markup).toContain('data-kind="washer"');
        expect(markup).not.toContain('min-w-[');
    });
});
