import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {installStepOrder} from './install-step-order';

describe('app install guidance order', () => {
    it('PC에서는 설치·로그인부터 푸시 테스트까지 선행 조건 순서로 안내한다', () => {
        expect(installStepOrder(false)).toEqual(['pc', 'pairing', 'pwa', 'push']);
    });

    it('모바일에서는 현재 수행할 PWA 설치를 먼저 보여 준다', () => {
        expect(installStepOrder(true)).toEqual(['pwa', 'pc', 'pairing', 'push']);
    });

    it('필수 적용 범위와 QR·코드·수동 설치·푸시 테스트를 명시한다', () => {
        const source = readFileSync(new URL('./app-install-page.tsx', import.meta.url), 'utf8');

        for (const text of [
            'PC 앱 설치·로그인',
            'QR 또는 코드로 연결',
            'PWA 설치',
            '푸시 알림 테스트',
            '출석·개인 알림에 필요',
            '수동 설치 방법',
        ]) {
            expect(source).toContain(text);
        }
        expect(source).not.toContain('badge="필수"');
    });
});
