import {describe, expect, test} from 'vitest';

import {desktopUpdatePollInterval} from './desktop-update-query';

describe('desktopUpdatePollInterval', () => {
    test.each(['checking', 'downloading', 'verifying', 'installing'] as const)(
        '%s 상태는 로컬 snapshot을 빠르게 polling한다',
        (status) => {
            expect(desktopUpdatePollInterval(status, false)).toBe(250);
        },
    );

    test('mutation 시작 직후와 정적 상태의 polling 주기를 구분한다', () => {
        expect(desktopUpdatePollInterval('mandatory', true)).toBe(250);
        expect(desktopUpdatePollInterval('optional', false)).toBe(60_000);
        expect(desktopUpdatePollInterval(undefined, false)).toBe(60_000);
    });
});
