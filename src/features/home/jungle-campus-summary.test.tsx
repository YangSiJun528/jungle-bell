import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./jungle-campus-summary.tsx', import.meta.url), 'utf8');

describe('JungleCampusSummary', () => {
    it('keeps one fixed-size campus surface and changes only its attendance content', () => {
        expect(source).toContain('h-[20rem]');
        expect(source).toContain("surface.kind === 'public'");
        expect(source).toContain('앱을 설치하고 PC와 연결하면 오늘 출석 상태를 확인할 수 있습니다.');
        expect(source).toContain("import jungleCompassIcon from '@/assets/logo.png'");
        expect(source).toContain('src={jungleCompassIcon}');
        expect(source).toContain('앱 설치 안내');
        expect(source).not.toContain('일반 웹에서는 출석 정보를 저장하거나 표시하지 않습니다.');
        expect(source).toContain('AttendanceChecks');
        expect(source).toContain('homeAttendanceForToday(attendance.data)');
        expect(source).toContain('useRefreshAttendanceMutation()');
        expect(source).toContain('refreshAttendance.mutate()');
        expect(source).toContain('오늘 출석 상태를 다시 확인해야 합니다.');
        expect(source).toContain('href="#attendance"');
        expect(source).toContain('overflow-y-auto');
        expect(source).toContain('min-h-full');
        expect(source).toContain('tabIndex={0}');
    });

    it('keeps cached attendance visible when only a background refresh fails', () => {
        expect(source).toContain('attendance.isPending && !attendance.data');
        expect(source).toContain('attendance.isError && !attendance.data');
        expect(source).toContain('attendance.isError && attendance.data');
    });
});
