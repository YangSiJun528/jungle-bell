import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const sheetSource = readFileSync(new URL('./sheet.tsx', import.meta.url), 'utf8');

describe('SheetContent overlay customization', () => {
    test('keeps the shared overlay default while allowing a focused class override', () => {
        expect(sheetSource).toContain('overlayClassName?: string');
        expect(sheetSource).toContain('<SheetOverlay className={overlayClassName} />');
        expect(sheetSource).toMatch(/['"]fixed inset-0 z-50 bg-black\/50/u);
    });
});
