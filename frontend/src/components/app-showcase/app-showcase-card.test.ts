import {describe, expect, it, vi} from 'vitest';

import {
    appShowcaseDismissed,
    dismissAppShowcase,
    HOME_INSTALL_PROMOTION_DISMISSED_KEY,
} from './app-showcase-dismissal';

describe('home install promotion dismissal', () => {
    it('현재 브라우저 세션에서 닫은 안내를 다시 표시하지 않는다', () => {
        const storage = {
            getItem: vi.fn<(key: string) => string | null>(() => 'dismissed'),
            setItem: vi.fn<(key: string, value: string) => void>(),
        };

        expect(appShowcaseDismissed(storage)).toBe(true);
        dismissAppShowcase(storage);
        expect(storage.setItem).toHaveBeenCalledWith(
            HOME_INSTALL_PROMOTION_DISMISSED_KEY,
            'dismissed',
        );
    });

    it('저장소 접근이 차단되면 안내를 표시하고 닫기 동작은 계속 허용한다', () => {
        const storage = {
            getItem: vi.fn<(key: string) => string | null>(() => {
                throw new Error('blocked');
            }),
            setItem: vi.fn<(key: string, value: string) => void>(() => {
                throw new Error('blocked');
            }),
        };

        expect(appShowcaseDismissed(storage)).toBe(false);
        expect(() => dismissAppShowcase(storage)).not.toThrow();
    });
});
