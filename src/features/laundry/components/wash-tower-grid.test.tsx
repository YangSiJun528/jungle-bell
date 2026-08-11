import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardLaundryMachine} from '../../../dashboard-model';
import {WashTowerGrid} from './wash-tower-grid';

const NOW_MS = Date.parse('2026-08-11T03:00:00.000Z');

const machines: DashboardLaundryMachine[] = [
    {
        id: '워시타워_9',
        zone: 'women',
        washer: null,
        dryer: null,
    },
    {
        id: '워시타워_1',
        zone: 'men',
        washer: {
            appliance: 'washer',
            operationalStatus: 'IDLE',
            projection: {status: 'IDLE', remainingMinutes: 0},
        },
        dryer: {
            appliance: 'dryer',
            operationalStatus: 'RUNNING',
            estimatedFinishAt: '2026-08-11T04:05:00.000Z',
            projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 70},
        },
    },
    {
        id: '워시타워_6',
        zone: 'common',
        washer: {
            appliance: 'washer',
            operationalStatus: 'ERROR',
            errorCode: 'OE',
            projection: {status: 'ERROR', remainingMinutes: 12},
        },
        dryer: {
            appliance: 'dryer',
            operationalStatus: 'PAUSED',
            projection: {status: 'PAUSED', remainingMinutes: 12},
        },
    },
];

describe('WashTowerGrid', () => {
    it('번호순 열과 실제 설치 순서인 건조기 위·세탁기 아래를 유지한다', () => {
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('워시타워 번호별 세탁기와 건조기 상태');
        expect(markup).toContain('role="region"');
        expect(markup).toContain('aria-label="워시타워 상태표"');
        expect(markup).toContain('tabindex="0"');
        expect(markup.indexOf('data-machine-id="워시타워_1"'))
            .toBeLessThan(markup.indexOf('data-machine-id="워시타워_6"'));
        expect(markup.indexOf('data-machine-id="워시타워_6"'))
            .toBeLessThan(markup.indexOf('data-machine-id="워시타워_9"'));
        expect(markup.indexOf('data-kind="dryer"'))
            .toBeLessThan(markup.indexOf('data-kind="washer"'));
    });

    it('구역과 상태에 맞는 셀 표현 및 접근성 설명을 제공한다', () => {
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('data-zone="men"');
        expect(markup).toContain('data-zone="common"');
        expect(markup).toContain('data-zone="women"');
        expect(markup).toContain('data-state="available"');
        expect(markup).toContain('data-state="unavailable"');
        expect(markup).toContain('data-state="error"');
        expect(markup).toContain('>✓</span>');
        expect(markup).toContain('>!</span>');
        expect(markup).toContain('>--:--</span>');
        expect(markup).toContain('aria-label="워시타워_1 세탁기 사용 가능"');
        expect(markup).toContain('title="워시타워_6 세탁기 오류"');
        expect(markup).toContain('aria-label="1번, 남성 구역"');
        expect(markup).toContain('aria-label="6번, 공용 구역"');
        expect(markup).toContain('aria-label="9번, 여성 구역"');
        expect(markup).toContain('border-blue-200 bg-blue-50 text-blue-700');
        expect(markup).toContain('border-violet-200 bg-violet-50 text-violet-700');
        expect(markup).toContain('border-rose-200 bg-rose-50 text-rose-700');
    });

    it('세탁기와 건조기 셀을 같은 규격으로 고정한다', () => {
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('data-wash-tower-cell="true"');
        expect(markup).toContain('h-10 w-full');
        expect(markup).toContain('data-kind="dryer"');
        expect(markup).toContain('data-kind="washer"');
    });

    it('전달한 nowMs를 기준으로 실행 중 잔여 시간을 고정한다', () => {
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('>01:05</span>');
        expect(markup).toContain('aria-label="워시타워_1 건조기 1시간 5분"');
        expect(markup).toContain('title="워시타워_1 건조기 1시간 5분"');
    });

    it('추정 잔여 시간은 요약에서도 예상값으로 표시한다', () => {
        const estimatedMachines = machines.map((machine) => machine.id === '워시타워_1'
            ? {
                ...machine,
                dryer: machine.dryer ? {
                    ...machine.dryer,
                    projection: {...machine.dryer.projection, estimated: true},
                } : null,
            }
            : machine);
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={estimatedMachines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('>≈01:05</span>');
        expect(markup).toContain('aria-label="워시타워_1 건조기 예상 1시간 5분"');
        expect(markup).toContain('title="워시타워_1 건조기 예상 1시간 5분"');
    });
});
