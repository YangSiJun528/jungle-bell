import {describe, expect, test} from 'vitest';

import {normalizeLegacyDashboardHash} from './routes';

describe('legacy mobile setup hash', () => {
    test('이전 setup hash를 React mount 전에 설치 안내로 바꾼다', () => {
        expect(normalizeLegacyDashboardHash('#setup')).toBe('#/install');
        expect(normalizeLegacyDashboardHash('#/setup')).toBe('#/install');
    });
});
