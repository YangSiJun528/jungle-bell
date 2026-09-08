import {describe, expect, it, vi} from 'vitest';

import type {PlatformAdapter} from '@/platform/contracts';

import {desktopExternalOpener} from './external-link-controller';

describe('desktopExternalOpener', () => {
    it('desktop production adapter의 검증된 system opener를 사용한다', async () => {
        const open = vi.fn<(url: string) => Promise<void>>(async () => undefined);
        const platform = {kind: 'desktop', externalLinks: {open}} as unknown as PlatformAdapter;

        await expect(
            desktopExternalOpener(platform)?.('https://github.com/YangSiJun528/jungle-bell'),
        ).resolves.toBeUndefined();
        expect(open).toHaveBeenCalledWith('https://github.com/YangSiJun528/jungle-bell');
    });

    it('browser에서는 표준 anchor 동작을 유지한다', () => {
        expect(
            desktopExternalOpener({kind: 'browser'} as unknown as PlatformAdapter),
        ).toBeUndefined();
    });
});
