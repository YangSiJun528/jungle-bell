import {describe, expect, it, vi} from 'vitest';

import type {NativeInvoke} from '@/platform/contracts';

import {createTauriExternalLinkAdapter, normalizeExternalUrl} from './external-links';

describe('TauriExternalLinkAdapter', () => {
    it.each([
        'https://github.com/YangSiJun528/jungle-bell',
        'https://github.com/YangSiJun528/jungle-bell#%EC%84%A4%EC%B9%98',
        'https://github.com/YangSiJun528/jungle-bell/issues/new/choose',
        'https://github.com/YangSiJun528/jungle-bell/releases/latest',
        'https://jungle-lms.krafton.com/check-in',
        'https://pf.kakao.com/_xhzNjn/posts',
        'https://pf.kakao.com/_xhzNjn/114222378',
        `https://jungle-bell.sijun-yang.com/api/public/assets/${'a'.repeat(64)}.webp`,
    ])('허용된 HTTPS 목적지만 정규화한다: %s', (url) => {
        expect(normalizeExternalUrl(url)).toBe(url);
    });

    it.each([
        'http://github.com/YangSiJun528/jungle-bell',
        'javascript:alert(1)',
        'https://evil.example/YangSiJun528/jungle-bell',
        'https://github.com.evil.example/YangSiJun528/jungle-bell',
        'https://user:pass@github.com/YangSiJun528/jungle-bell',
        'https://github.com:444/YangSiJun528/jungle-bell',
        'https://github.com/YangSiJun528/jungle-bell/issues/69',
        'https://jungle-lms.krafton.com/check-in?next=https://evil.example',
        'https://pf.kakao.com/_xhzNjn/0',
        `https://jungle-bell.sijun-yang.com/api/public/assets/${'a'.repeat(63)}.png`,
    ])('허용 목록 밖 URL을 거부한다: %s', (url) => {
        expect(() => normalizeExternalUrl(url)).toThrow('EXTERNAL_URL_NOT_ALLOWED');
    });

    it('검증한 URL만 opener 플러그인에 넘기고 native 실패를 호출자에게 전달한다', async () => {
        const nativeError = new Error('SYSTEM_BROWSER_OPEN_FAILED');
        const invoke = vi.fn<NativeInvoke>(async () => {
            throw nativeError;
        });
        const adapter = createTauriExternalLinkAdapter(invoke);

        await expect(adapter.open('https://github.com/YangSiJun528/jungle-bell')).rejects.toBe(
            nativeError,
        );
        expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
            url: 'https://github.com/YangSiJun528/jungle-bell',
        });
    });

    it('검증 실패 시 native 호출을 시작하지 않는다', async () => {
        const invoke = vi.fn<NativeInvoke>();
        const adapter = createTauriExternalLinkAdapter(invoke);

        await expect(adapter.open('file:///etc/passwd')).rejects.toThrow(
            'EXTERNAL_URL_NOT_ALLOWED',
        );
        expect(invoke).not.toHaveBeenCalled();
    });
});
