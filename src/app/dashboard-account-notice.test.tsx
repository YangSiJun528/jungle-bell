import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./dashboard-account-notice.tsx', import.meta.url), 'utf8');

describe('DashboardAccountNotice', () => {
    test('전역 LMS 인증 상태가 필요한 desktop에서 로그인 CTA를 제공한다', () => {
        expect(source).toContain('useDashboardAccount()');
        expect(source).toContain("status.lmsAuthentication !== 'required'");
        expect(source).toContain('api.openLmsLogin()');
        expect(source).toContain('LMS 로그인이 필요합니다.');
        expect(source).toContain('LMS 로그인');
    });
});
