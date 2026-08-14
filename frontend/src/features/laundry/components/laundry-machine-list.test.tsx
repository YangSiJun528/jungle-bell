import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
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
        expect(markup).not.toContain('마지막 수집 시점 기준');
        expect(markup.indexOf('1번 워시타워')).toBeLessThan(markup.indexOf('2번 워시타워'));
        expect(markup.indexOf('>건조기<')).toBeLessThan(markup.indexOf('>세탁기<'));
        expect(markup).toContain('세탁기');
        expect(markup).toContain('건조기');
        expect(markup).toContain('헹굼 중');
        expect(markup).toContain('30분');
        expect(markup).toContain('총 60분');
        expect(markup).not.toMatch(/예상|약 30분|30분 남음/u);
        expect(markup).toContain('사용 가능');
        expect(markup).toContain('배관 에러');
        expect(markup).toContain('aria-label="1번 워시타워 건조기 상세 안내"');
        expect(markup).not.toContain('aria-label="2번 워시타워 세탁기 상세 안내"');
        expect(markup).not.toContain('EMPTY_WATER_ALERT_ERROR');
    });

    it('진행률과 시간 정보를 접근 가능한 이름으로 제공한다', () => {
        const markup = renderToStaticMarkup(
            <LaundryMachineList machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('role="progressbar"');
        expect(markup).toContain('aria-label="2번 워시타워 세탁 진행률"');
        expect(markup).toContain('aria-valuenow="50"');
        expect(markup).not.toContain('>예상 진행률 50%</p>');
        expect(markup).toContain('aria-valuetext="50% 진행, 30분, 총 60분"');
        expect(markup).toContain('aria-valuetext="오류로 진행률을 확인할 수 없음"');
        expect(markup).toContain('11:30 시작');
        expect(markup).toContain('12:30 종료');
    });

    it('완료 확인 상태에만 보정값 안내를 열 수 있는 버튼을 표시한다', () => {
        const markup = renderToStaticMarkup(
            <LaundryMachineList
                machines={[{
                    id: '워시타워_3',
                    zone: 'men',
                    washer: null,
                    dryer: {
                        appliance: 'dryer',
                        operationalStatus: 'RUNNING',
                        state: {code: 'END'},
                        estimatedFinishAt: '2026-08-11T02:59:00.000Z',
                        projection: {
                            status: 'AWAITING_COMPLETION_CONFIRMATION',
                            remainingMinutes: 0,
                            estimated: true,
                        },
                    },
                }]}
                nowMs={NOW_MS}
            />,
        );

        expect(markup).toContain('완료 확인 중');
        expect(markup).toContain('data-state="confirming"');
        expect(markup).toContain('aria-valuenow="100"');
        expect(markup).toContain('aria-valuetext="100% 진행, 0분"');
        expect(markup).toContain('lucide-info');
        expect(markup).not.toContain('예상');
        expect(markup).toContain('aria-label="3번 워시타워 건조기 상세 안내"');
    });

    it('상세 목록은 기본 앱 너비에서 워시타워 세 개를 한 행에 배치한다', () => {
        const markup = renderToStaticMarkup(
            <LaundryMachineList machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('data-laundry-detail-list="true"');
        expect(markup).toContain('data-laundry-machine-card="true"');
        expect(markup).toContain('[.border-b]:pb-3');
        expect(markup).toContain('<h3 class="text-base font-semibold leading-none">1번 워시타워</h3>');
        expect(markup).toContain('auto-rows-fr');
        expect(markup).toContain('md:grid-cols-2');
        expect(markup).toContain('lg:grid-cols-3');
        expect(markup).not.toContain('2xl:grid-cols-3');
        expect(markup).toContain('grid flex-1 grid-rows-2');
        expect(markup).toContain('data-kind="dryer"');
        expect(markup).toContain('data-kind="washer"');
        expect(markup).not.toContain('min-w-[');
    });
});
