import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
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
        const availableMarkup = renderToStaticMarkup(
            <WashTowerGrid
                machines={machines.map((machine) => ({
                    ...machine,
                    washer: {
                        appliance: 'washer',
                        operationalStatus: 'IDLE',
                        projection: {status: 'IDLE', remainingMinutes: 0},
                    },
                }))}
                nowMs={NOW_MS}
            />,
        );

        expect(markup).toContain('data-zone="men"');
        expect(markup).toContain('data-zone="common"');
        expect(markup).toContain('data-zone="women"');
        expect(markup).toContain('data-state="available"');
        expect(markup).toContain('data-state="unavailable"');
        expect(markup).toContain('data-state="error"');
        expect(markup).toContain('>✓</span>');
        expect(markup).toContain('>경고</span>');
        expect(markup).not.toContain('>!</span>');
        expect(markup).toContain('>--:--</span>');
        expect(markup).toContain('aria-label="워시타워_1 세탁기 사용 가능"');
        expect(markup).toContain('title="워시타워_6 세탁기 오류"');
        expect(markup).toContain('aria-label="1번, 남성 구역"');
        expect(markup).toContain('aria-label="6번, 공용 구역"');
        expect(markup).toContain('aria-label="9번, 여성 구역"');
        expect(markup).toContain('title="남성 구역"');
        expect(markup).toContain('text-blue-700 dark:text-blue-300');
        expect(markup).toContain('text-violet-700 dark:text-violet-300');
        expect(markup).toContain('text-rose-700 dark:text-rose-300');
        expect(availableMarkup).toContain('bg-[oklch(0.68_0.07_250)]');
        expect(availableMarkup).toContain('bg-[oklch(0.68_0.065_300)]');
        expect(availableMarkup).toContain('bg-[oklch(0.68_0.07_15)]');
        expect(markup).toContain('bg-[oklch(0.68_0.055_25)]');
        expect(availableMarkup).not.toMatch(/bg-(?:blue|violet|rose)-100/u);
        expect(markup).not.toContain('bg-red-100/70');

        const numberTags = markup.match(/<span[^>]*data-laundry-zone-number="true"[^>]*>/gu) ?? [];
        expect(numberTags).toHaveLength(3);
        for (const tag of numberTags) {
            expect(tag).not.toMatch(/\b(?:border(?:-\S+)?|rounded(?:-\S+)?|bg-(?:blue|violet|rose)-\S+)/u);
        }
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

    it('카드 구분선 아래에 별도 상단 마진을 만들지 않는다', () => {
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).not.toContain('class="mt-4 ');
    });

    it('전달한 nowMs를 기준으로 실행 중 잔여 시간을 고정한다', () => {
        const markup = renderToStaticMarkup(
            <WashTowerGrid machines={machines} nowMs={NOW_MS}/>,
        );

        expect(markup).toContain('>01:05</span>');
        expect(markup).toContain('aria-label="워시타워_1 건조기 1시간 5분"');
        expect(markup).toContain('title="워시타워_1 건조기 1시간 5분"');
    });

    it('추정 잔여 시간은 기호 없이 표시하고 접근성 설명에서 예상값임을 알린다', () => {
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

        expect(markup).toContain('>01:05</span>');
        expect(markup).not.toContain('≈');
        expect(markup).toContain('aria-label="워시타워_1 건조기 예상 1시간 5분"');
        expect(markup).toContain('title="워시타워_1 건조기 예상 1시간 5분"');
    });
});
