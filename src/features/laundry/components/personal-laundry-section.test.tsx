import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import type {DashboardLaundrySnapshot, LaundryQueueEntry, LaundryWatch} from '@/api/dashboard-api';
import {PersonalLaundrySection} from './personal-laundry-section';

const {api, queryKeys} = vi.hoisted(() => ({
    queryKeys: {
        laundryWatches: ['personal', 'laundry-watches'] as const,
        laundryQueue: ['personal', 'laundry-queue'] as const,
    },
    api: {
        listLaundryWatches: vi.fn(),
        createLaundryWatch: vi.fn(),
        deleteLaundryWatch: vi.fn(),
        listLaundryQueue: vi.fn(),
        joinLaundryQueue: vi.fn(),
        leaveLaundryQueue: vi.fn(),
    },
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => ({api}),
}));

const machines: DashboardLaundrySnapshot['machines'] = [{
    id: '워시타워_1',
    zone: 'men',
    washer: {
        appliance: 'washer',
        operationalStatus: 'RUNNING',
        projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 23},
    },
    dryer: {
        appliance: 'dryer',
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    },
}];

const activeWatch: LaundryWatch = {
    id: 'watch-1',
    machineId: '워시타워_1',
    appliance: 'washer',
    sessionId: 'washer-session',
    notifyBeforeMinutes: 10,
    notifyWhenAvailable: true,
    status: 'active',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
};

const waitingQueue: LaundryQueueEntry = {
    id: 'queue-1',
    machineId: null,
    appliance: 'washer',
    status: 'waiting',
    joinedAtEpochMs: 1,
    leftAtEpochMs: null,
    position: 2,
};

function renderPersonalLaundry(options: {
    watches?: LaundryWatch[];
    queue?: LaundryQueueEntry[];
    machines?: DashboardLaundrySnapshot['machines'];
} = {}): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.laundryWatches, options.watches ?? [activeWatch]);
    client.setQueryData(queryKeys.laundryQueue, options.queue ?? [waitingQueue]);

    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <PersonalLaundrySection
                surface="desktop"
                machines={options.machines ?? machines}
            />
        </QueryClientProvider>,
    );
}

describe('PersonalLaundrySection', () => {
    test('개인 알림과 자율 대기열을 독립된 섹션으로 표시한다', () => {
        const markup = renderPersonalLaundry();

        expect(markup).toContain('aria-label="개인 세탁 기능"');
        expect(markup).toContain('내 세탁 알림');
        expect(markup).toContain('1번 · 세탁기');
        expect(markup).toContain('이 동작 종료 10분 전·완료·사용 가능 전환 알림');
        expect(markup).toContain('자율 대기열');
        expect(markup).toContain('세탁기 대기 취소');
        expect(markup).toContain('대기 중 · 현재 2번째');
    });

    test('기기 상태가 없어도 개인 제어의 빈 상태를 안전하게 표시한다', () => {
        const markup = renderPersonalLaundry({watches: [], queue: [], machines: []});

        expect(markup).toContain('기기 상태가 확인되면 알림 대상을 선택할 수 있습니다.');
        expect(markup).toContain('설정된 세탁 알림이 없습니다.');
        expect(markup).toContain('참여 중인 자율 대기열이 없습니다.');
    });
});
