import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

import {isMobileInstallClient} from './install-client';
import {
    initialInstallPromptState,
    reduceInstallPromptState,
    type InstallPromptState,
} from './install-prompt-state';

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

describe('PWA install prompt state', () => {
    const prompt = {prompt: async () => 'accepted' as const};

    test('초기 상태에서 자동 설치 미지원과 이미 설치됨을 구분한다', () => {
        expect(initialInstallPromptState(false)).toEqual({status: 'unsupported'});
        expect(initialInstallPromptState(true)).toEqual({status: 'already-installed'});
    });

    test('설치 가능 이벤트와 사용자 선택 결과를 별도 상태로 보존한다', () => {
        const available = reduceInstallPromptState(initialInstallPromptState(false), {
            type: 'prompt-available',
            prompt,
        });

        expect(available).toEqual({status: 'available', prompt});
        expect(
            reduceInstallPromptState(available, {type: 'prompt-dismissed'}),
        ).toEqual<InstallPromptState>({status: 'dismissed'});
        expect(
            reduceInstallPromptState(available, {type: 'prompt-accepted'}),
        ).toEqual<InstallPromptState>({status: 'completed'});
    });

    test('거절 후 설치 가능 여부 재확인과 브라우저 설치 완료 이벤트를 복구 경로로 처리한다', () => {
        expect(
            reduceInstallPromptState({status: 'dismissed'}, {type: 'recheck'}),
        ).toEqual<InstallPromptState>({status: 'unsupported'});
        expect(
            reduceInstallPromptState({status: 'unsupported'}, {type: 'app-installed'}),
        ).toEqual<InstallPromptState>({status: 'completed'});
    });

    test('각 설치 상태에 사용자 설명과 재시도·수동 설치 행동을 제공한다', () => {
        const source = readFileSync(new URL('./install-prompt.tsx', import.meta.url), 'utf8');

        for (const text of [
            'Jungle Bell을 홈 화면에 추가',
            '자동 설치를 사용할 수 없습니다.',
            '설치를 취소했습니다.',
            '설치 요청을 완료했습니다.',
            'Jungle Bell이 이미 설치되어 있습니다.',
            '설치 가능 여부 다시 확인',
            '이 설치 요청은 다시 실행할 수 없습니다.',
            '브라우저가 새 설치 요청을 제공하면 이 안내에 표시됩니다.',
            '수동 설치 방법',
        ]) {
            expect(source).toContain(text);
        }
        expect(source).not.toContain('설치 다시 시도');
    });
});
