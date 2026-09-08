import {describe, expect, test} from 'vitest';

import {DESKTOP_SHELL_BREAKPOINT, isMobileViewportWidth} from './use-mobile';

describe('dashboard shell viewport contract', () => {
    test('expanded sidebar starts at 1024 CSS px', () => {
        expect(DESKTOP_SHELL_BREAKPOINT).toBe(1024);
    });

    test.each([
        [320, true],
        [390, true],
        [760, true],
        [768, true],
        [1023, true],
        [1024, false],
        [1440, false],
    ] as const)('%dpx uses the expected shell', (width, expectedMobileShell) => {
        expect(isMobileViewportWidth(width)).toBe(expectedMobileShell);
    });
});
