import assert from 'node:assert/strict';

import {test} from 'vitest';

import {isMobileInstallClient} from './install-client';

test('iOS·Android와 iPad 데스크톱 UA를 모바일 설치 대상으로 판정한다', () => {
    assert.equal(
        isMobileInstallClient({
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        }),
        true,
    );
    assert.equal(
        isMobileInstallClient({userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile'}),
        true,
    );
    assert.equal(
        isMobileInstallClient({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
            platform: 'MacIntel',
            maxTouchPoints: 5,
        }),
        true,
    );
});

test('일반 PC 브라우저는 PC 앱 설치 대상으로 판정한다', () => {
    assert.equal(
        isMobileInstallClient({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7)',
            platform: 'MacIntel',
            maxTouchPoints: 0,
        }),
        false,
    );
    assert.equal(
        isMobileInstallClient({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            platform: 'Win32',
            maxTouchPoints: 0,
        }),
        false,
    );
});
