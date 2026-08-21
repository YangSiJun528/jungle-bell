import {readFileSync} from 'node:fs';

import {describe, expect, test, vi} from 'vitest';

import {parseAndScrubInitialPairing} from './pairing-bootstrap';

describe('initial QR pairing bootstrap', () => {
    const hash = '#pairing=jbp_123&challenge=jbpc_one-time-secret';

    test('설치형 PWA는 secret을 메모리에만 반환하고 앱 홈에서 직접 연결한다', () => {
        const replaceState = vi.fn();

        const entry = parseAndScrubInitialPairing({
            hash,
            authentication: 'cookie',
            mobileInstallClient: true,
            pathname: '/',
            search: '?source=qr',
            historyState: {navigation: 1},
            replaceState,
        });

        expect(entry).toEqual({
            kind: 'companion',
            link: {pairingId: 'jbp_123', challenge: 'jbpc_one-time-secret'},
        });
        expect(replaceState).toHaveBeenCalledOnce();
        expect(replaceState).toHaveBeenCalledWith({navigation: 1}, '', '/?source=qr#/home');
    });

    test('데스크톱은 모바일용 QR secret을 보존하지 않는다', () => {
        const replaceState = vi.fn();

        const entry = parseAndScrubInitialPairing({
            hash,
            authentication: 'desktop-session',
            mobileInstallClient: false,
            pathname: '/',
            search: '',
            historyState: null,
            replaceState,
        });

        expect(entry).toBeNull();
        expect(JSON.stringify(entry)).not.toContain('one-time-secret');
        expect(replaceState).toHaveBeenCalledWith(null, '', '/#/home');
    });

    test('일반 모바일 브라우저는 QR을 설치 안내 handoff로 처리한다', () => {
        const replaceState = vi.fn();

        const entry = parseAndScrubInitialPairing({
            hash,
            authentication: 'none',
            mobileInstallClient: true,
            pathname: '/',
            search: '',
            historyState: null,
            replaceState,
        });

        expect(entry).toEqual({
            kind: 'install-handoff',
            link: {pairingId: 'jbp_123', challenge: 'jbpc_one-time-secret'},
        });
        expect(replaceState).toHaveBeenCalledWith(null, '', '/#/install');
    });

    test('데스크톱 일반 웹은 QR secret을 제거하고 공개 홈으로 복귀한다', () => {
        const replaceState = vi.fn();

        const entry = parseAndScrubInitialPairing({
            hash,
            authentication: 'none',
            mobileInstallClient: false,
            pathname: '/',
            search: '',
            historyState: null,
            replaceState,
        });

        expect(entry).toBeNull();
        expect(replaceState).toHaveBeenCalledWith(null, '', '/#/home');
    });

    test('일반 경로는 history를 변경하지 않는다', () => {
        const replaceState = vi.fn();
        expect(
            parseAndScrubInitialPairing({
                hash: '#laundry',
                authentication: 'none',
                mobileInstallClient: true,
                pathname: '/',
                search: '',
                historyState: null,
                replaceState,
            }),
        ).toBeNull();
        expect(replaceState).not.toHaveBeenCalled();
    });

    test('앱 진입점이 React mount 전에 메모리 capture를 실행하고 bootstrap은 storage를 쓰지 않는다', () => {
        const main = readFileSync(new URL('./bootstrap.tsx', import.meta.url), 'utf8');
        const bootstrap = readFileSync(new URL('./pairing-bootstrap.ts', import.meta.url), 'utf8');

        expect(main.indexOf('captureInitialPairingFromWindow(')).toBeGreaterThan(-1);
        expect(main.indexOf('captureInitialPairingFromWindow(')).toBeLessThan(
            main.indexOf('createRoot(root).render('),
        );
        expect(bootstrap).not.toMatch(/localStorage|sessionStorage/u);
    });
});
