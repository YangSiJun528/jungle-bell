import {readFileSync} from 'node:fs';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {AttendancePreferences} from '@/api/personal-api';

import {AttendancePreferencesSection} from './attendance-preferences-section';

const {api, queryKeys} = vi.hoisted(() => ({
    api: {
        getAttendancePreferences: vi.fn<() => Promise<AttendancePreferences>>(),
        updateAttendancePreferences:
            vi.fn<(input: AttendancePreferences) => Promise<AttendancePreferences>>(),
    },
    queryKeys: {
        attendancePreferences: ['personal', 'attendance-preferences'] as const,
    },
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => ({api}),
}));

vi.mock('@/app/dashboard-account', () => ({
    useDashboardAccount: () => ({personalAccess: {status: 'connected'}}),
}));

vi.mock('@/app/use-dashboard-queries', () => ({
    useAttendanceQuery: () => ({
        data: {
            state: 'loaded',
            attendance: {
                status: 'available',
                snapshot: {attendanceDate: '2026-08-12'},
            },
        },
    }),
}));

const source = readFileSync(
    new URL('./attendance-preferences-section.tsx', import.meta.url),
    'utf8',
);

const preferences: AttendancePreferences = {
    enabled: true,
    morning: true,
    evening: true,
    morningStartHour: 7,
    eveningEndHour: 2,
    morningIntervalMinutes: 5,
    eveningIntervalMinutes: 10,
    skipSunday: true,
    skipAttendanceDate: null,
};

function renderPreferences(): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.attendancePreferences, preferences);
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <AttendancePreferencesSection />
        </QueryClientProvider>,
    );
}

describe('AttendancePreferencesSection', () => {
    test('서버 공유 출석 알림의 모든 스위치와 시간 선택을 표시한다', () => {
        const markup = renderPreferences();

        for (const label of [
            '출석 알림 사용',
            '학습 시작 알림',
            '학습 시작 확인 시각',
            '학습 시작 확인 간격',
            '학습 종료 알림',
            '학습 종료 확인 종료 시각',
            '학습 종료 확인 간격',
            '일요일 제외',
            '이번 출석일 건너뛰기',
        ]) {
            expect(markup).toContain(`aria-label="${label}"`);
        }
        expect(markup).toContain('출석 알림 저장');
    });

    test('계약 범위의 시간과 간격만 선택하고 PC와 PWA에서 같은 API를 사용한다', () => {
        expect(source).toContain('const MORNING_START_HOURS = [4, 5, 6, 7, 8, 9] as const;');
        expect(source).toContain('const EVENING_END_HOURS = [0, 1, 2, 3, 4] as const;');
        expect(source).toContain('const INTERVAL_MINUTES = [1, 3, 5, 10, 15, 30] as const;');
        expect(source).toContain('api.getAttendancePreferences()');
        expect(source).toContain('api.updateAttendancePreferences(input)');
        expect(renderPreferences()).toContain('출석 알림 설정');
    });
});
