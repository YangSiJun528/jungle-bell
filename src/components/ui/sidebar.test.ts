import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

const sidebarSource = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');

describe('SidebarProvider keyboard shortcut', () => {
    test('allows a fixed sidebar to opt out without changing the shared default', () => {
        expect(sidebarSource).toContain('keyboardShortcut = SIDEBAR_KEYBOARD_SHORTCUT');
        expect(sidebarSource).toContain('keyboardShortcut?: string | null');
        expect(sidebarSource).toContain('if (!keyboardShortcut) return');
    });
});
