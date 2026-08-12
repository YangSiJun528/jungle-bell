import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./attendance-page.tsx', import.meta.url), 'utf8');

describe('AttendancePage LMS gate', () => {
    test('인증 전에는 출석 결과 대신 로그인 UI를 우선 표시한다', () => {
        expect(source).toContain('useDashboardAccount()');
        expect(source).toContain("account.status.lmsAuthentication === 'required'");
        expect(source).toContain("refreshAttendance.error.message === 'LMS_AUTH_REQUIRED'");
        expect(source).toContain('LMS 로그인');
    });
});
