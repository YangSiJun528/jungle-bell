import {describe, expect, test} from 'vitest';
import {accountAuthenticationRequired} from './account-authentication';

describe('accountAuthenticationRequired', () => {
    test('계정 재인증 오류만 일반 API 장애와 구분한다', () => {
        for (const code of [
            'HTTP_401',
            'UNAUTHORIZED',
            'AUTHENTICATION_REQUIRED',
            'SESSION_EXPIRED',
            'MOBILE_SESSION_REQUIRED',
        ]) {
            expect(accountAuthenticationRequired(new Error(code))).toBe(true);
        }
        expect(accountAuthenticationRequired(new Error('UPSTREAM_UNAVAILABLE'))).toBe(false);
        expect(accountAuthenticationRequired('AUTHENTICATION_REQUIRED')).toBe(false);
    });
});
