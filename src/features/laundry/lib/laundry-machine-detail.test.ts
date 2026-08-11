import {describe, expect, it} from 'vitest';
import type {DashboardLaundryMachine} from '@/dashboard-model';
import {
    laundryApplianceDetail,
    laundryMachineDetail,
} from './laundry-machine-detail';

const NOW_MS = Date.parse('2026-08-11T03:00:00.000Z');

describe('laundryApplianceDetail', () => {
    it('작동 중 기기의 세부 상태와 잔여·전체 시간 및 진행률을 만든다', () => {
        expect(laundryApplianceDetail({
            appliance: 'washer',
            operationalStatus: 'RUNNING',
            state: {code: 'RINSING'},
            totalMinutes: 60,
            startedAt: '2026-08-11T02:30:00.000Z',
            estimatedFinishAt: '2026-08-11T03:30:00.000Z',
            projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 35},
        }, 'washer', NOW_MS)).toEqual({
            kind: 'washer',
            label: '세탁기',
            statusLabel: '헹굼 중',
            tone: 'active',
            remainingLabel: '30분 남음',
            totalLabel: '전체 60분',
            progress: 50,
            startedAt: '2026-08-11T02:30:00.000Z',
            estimatedFinishAt: '2026-08-11T03:30:00.000Z',
            errorCode: null,
            helpText: null,
            estimated: false,
        });
    });

    it('서버가 추정한 상태·잔여 시간·진행률은 예상값으로 명시한다', () => {
        expect(laundryApplianceDetail({
            appliance: 'washer',
            operationalStatus: 'RUNNING',
            state: {code: 'RINSING'},
            totalMinutes: 60,
            estimatedFinishAt: '2026-08-11T03:30:00.000Z',
            projection: {
                status: 'ESTIMATED_RUNNING',
                remainingMinutes: 35,
                estimated: true,
            },
        }, 'washer', NOW_MS)).toMatchObject({
            statusLabel: '헹굼 중 · 예상',
            remainingLabel: '약 30분 남음',
            progress: 50,
            estimated: true,
        });
    });

    it('사용 가능·정보 없음·오류 상태를 구분하고 오류에는 빈 진행률을 유지한다', () => {
        expect(laundryApplianceDetail({
            appliance: 'dryer',
            operationalStatus: 'IDLE',
            projection: {status: 'IDLE', remainingMinutes: 0},
        }, 'dryer', NOW_MS)).toMatchObject({
            statusLabel: '사용 가능',
            tone: 'available',
            remainingLabel: '바로 사용할 수 있어요',
            progress: null,
        });

        expect(laundryApplianceDetail(null, 'washer', NOW_MS)).toMatchObject({
            statusLabel: '정보 없음',
            tone: 'neutral',
            remainingLabel: '상태를 확인할 수 없어요',
            progress: null,
        });

        expect(laundryApplianceDetail({
            appliance: 'dryer',
            operationalStatus: 'ERROR',
            errorCode: 'EMPTY_WATER_ALERT_ERROR',
            projection: {status: 'ERROR'},
        }, 'dryer', NOW_MS)).toMatchObject({
            statusLabel: '배관 에러',
            tone: 'error',
            remainingLabel: '기기 확인이 필요해요',
            progress: 0,
            errorCode: 'EMPTY_WATER_ALERT_ERROR',
            helpText: '필터를 청소한 뒤 기기 상태를 직접 확인해 주세요.',
        });
    });

    it('일시 정지와 완료 확인 지연을 경고 상태로 설명한다', () => {
        expect(laundryApplianceDetail({
            appliance: 'washer',
            operationalStatus: 'PAUSED',
            totalMinutes: 30,
            projection: {status: 'PAUSED', remainingMinutes: 12},
        }, 'washer', NOW_MS)).toMatchObject({
            statusLabel: '일시 정지',
            tone: 'warning',
            remainingLabel: '12분 남음',
            progress: 60,
        });

        expect(laundryApplianceDetail({
            appliance: 'dryer',
            operationalStatus: 'RUNNING',
            estimatedFinishAt: '2026-08-11T02:59:00.000Z',
            projection: {status: 'AWAITING_COMPLETION_CONFIRMATION', remainingMinutes: 0},
        }, 'dryer', NOW_MS)).toMatchObject({
            statusLabel: '완료 확인 지연',
            tone: 'warning',
            helpText: '예상 종료 시각이 지났지만 완료 상태가 아직 확인되지 않았어요.',
        });

        expect(laundryApplianceDetail({
            appliance: 'dryer',
            operationalStatus: 'RUNNING',
            state: {code: 'END'},
            estimatedFinishAt: '2026-08-11T03:05:00.000Z',
            projection: {status: 'AWAITING_COMPLETION_CONFIRMATION', remainingMinutes: 5},
        }, 'dryer', NOW_MS)).toMatchObject({
            statusLabel: '완료 확인 중',
            tone: 'active',
        });
    });

    it('수집기 sentinel 또는 현재 세션으로 볼 수 없는 시작 시각은 숨긴다', () => {
        expect(laundryApplianceDetail({
            appliance: 'dryer',
            operationalStatus: 'RUNNING',
            startedAt: '1970-01-01T00:00:00.000Z',
            projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 10},
        }, 'dryer', NOW_MS).startedAt).toBeNull();

        expect(laundryApplianceDetail({
            appliance: 'dryer',
            operationalStatus: 'RUNNING',
            startedAt: '2026-08-09T03:00:00.000Z',
            projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 10},
        }, 'dryer', NOW_MS).startedAt).toBeNull();
    });

    it('사용 가능 상태에는 이전 세션의 시작·종료 시각을 노출하지 않는다', () => {
        expect(laundryApplianceDetail({
            appliance: 'washer',
            operationalStatus: 'IDLE',
            startedAt: '2026-08-11T02:00:00.000Z',
            estimatedFinishAt: '2026-08-11T02:50:00.000Z',
            projection: {status: 'IDLE', remainingMinutes: 0},
        }, 'washer', NOW_MS)).toMatchObject({
            startedAt: null,
            estimatedFinishAt: null,
        });
    });
});

describe('laundryMachineDetail', () => {
    it('기기 번호와 구역을 사람이 읽기 쉬운 제목으로 만든다', () => {
        const machine: DashboardLaundryMachine = {
            id: '워시타워_6',
            zone: 'common',
            washer: null,
            dryer: null,
        };

        expect(laundryMachineDetail(machine, NOW_MS)).toMatchObject({
            id: '워시타워_6',
            title: '6번 워시타워',
            zoneLabel: '공용 구역',
        });
    });
});
