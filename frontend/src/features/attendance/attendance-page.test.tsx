import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./attendance-page.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./attendance-page-state.ts', import.meta.url), 'utf8');
const normalizedSource = source.replace(/\s+/gu, ' ');
const combinedSource = `${source}\n${stateSource}`;

describe('AttendancePage LMS gate', () => {
    test('인증 전에는 출석 결과 대신 로그인 UI를 우선 표시한다', () => {
        expect(source).toContain('useDashboardAccount()');
        expect(stateSource).toContain("accountStatus.lmsAuthentication === 'required'");
        expect(normalizedSource).toContain(
            'refreshAttendance.isError ? refreshAttendance.error.message : null',
        );
        expect(source).toContain("errorMessage === 'LMS_AUTH_REQUIRED'");
        expect(source).toContain('LMS 로그인');
    });

    test('출석 상세에서도 현재 기수 D-Day 카드를 표시한다', () => {
        expect(source).toContain("import {DdayCard} from '@/components/dashboard/dday-card'");
        expect(source).toContain("import {selectDdayView} from '@/domain/attendance/dday-view'");
        expect(source).toContain('<DdayCard view={dday} />');
    });

    test('일반 웹에서는 출석 로딩 대신 앱 연결 안내를 표시한다', () => {
        expect(stateSource).toContain("personalAccessStatus === 'not-applicable'");
        expect(stateSource).toContain('출석은 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다.');
    });

    test('PC 로컬 관측이 있으면 서버 동기화와 무관하게 출석을 표시한다', () => {
        expect(stateSource).toContain('desktopLocalAttendanceAvailable');
        expect(normalizedSource).toContain('다른 기기 동기화 대기 중');
        expect(combinedSource).toContain(
            "detail.source === 'desktop' ? '마지막 확인' : '마지막 동기화'",
        );
    });

    test('출석 상태와 공식 서비스 카드는 한 화면에서 빠르게 훑을 수 있는 밀도로 표시한다', () => {
        expect(source).toContain('data-attendance-card="today"');
        expect(source).toContain('data-attendance-card="campus"');
        expect(source).toContain('data-attendance-check={label}');
        expect(normalizedSource).toContain(
            'className="flex flex-wrap items-baseline justify-between gap-2"',
        );
        expect(source).toContain('className="gap-0 py-0"');
        expect(source).toContain('lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]');
        expect(source).not.toContain('xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]');
        expect(source).not.toContain('<strong className="mt-3 block text-xl">');
    });
});
