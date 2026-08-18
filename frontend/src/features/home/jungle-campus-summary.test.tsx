import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./jungle-campus-summary.tsx', import.meta.url), 'utf8');

describe('JungleCampusSummary', () => {
    it('keeps one fixed-size campus surface and changes only its attendance content', () => {
        expect(source).toContain('h-[20rem]');
        expect(source).not.toContain("surface.kind === 'public'");
        expect(source).toContain('CalendarCheck');
        expect(source).toContain('data-home-campus-status-icon="true"');
        expect(source).not.toContain("import jungleCompassIcon from '@/assets/logo.png'");
        expect(source).not.toContain('src={jungleCompassIcon}');
        expect(source).not.toContain('PublicCampusContent');
        expect(source).not.toContain('일반 웹에서는 출석 정보를 저장하거나 표시하지 않습니다.');
        expect(source).toContain('AttendanceChecks');
        expect(source).toContain('homeAttendanceForToday(attendance.data)');
        expect(source).toContain('useRefreshAttendanceMutation()');
        expect(source).toContain('useDashboardAccount()');
        expect(source).toContain("account.status.lmsAuthentication === 'required'");
        expect(source).toContain('refreshAttendance.mutate()');
        expect(source).toContain('오늘 출석 상태를 다시 확인해야 합니다.');
        expect(source).toContain('<Link to="/attendance">');
        expect(source).toContain('overflow-y-auto');
        expect(source).toContain('min-h-full');
        expect(source).toContain('tabIndex={0}');
        expect(source).toContain('selectDdayView({');
        expect(source).toContain('<DdayCard view={dday}/>');
        expect(source.indexOf('</CampusCardFrame>'))
            .toBeLessThan(source.indexOf('<DdayCard view={dday}/>'));
        expect(source).not.toContain('dashboardDdayPeriod');
    });

    it('keeps cached attendance visible when only a background refresh fails', () => {
        expect(source).toContain('attendance.isPending && !attendance.data');
        expect(source).toContain('attendance.isError && !attendance.data');
        expect(source).toContain('attendance.isError && attendance.data');
    });

    it('일반 웹에서는 비활성 출석 쿼리를 로딩으로 표시하지 않는다', () => {
        const unavailableBranch = source.indexOf("account.personalAccess.status === 'not-applicable'");
        const loadingBranch = source.indexOf('attendance.isPending && !attendance.data');

        expect(unavailableBranch).toBeGreaterThan(-1);
        expect(unavailableBranch).toBeLessThan(loadingBranch);
        expect(source).toContain('출석과 D-Day는 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다.');
    });
});
