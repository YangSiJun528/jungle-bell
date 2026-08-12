import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test} from 'vitest';
import {SidebarProvider, SidebarRail, SidebarTrigger} from './sidebar';

const sidebarSource = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');

describe('shadcn Sidebar controls', () => {
    test('공통 Trigger와 Rail에 한국어 접근성 이름을 제공한다', () => {
        const markup = renderToStaticMarkup(
            createElement(
                SidebarProvider,
                null,
                createElement(SidebarTrigger),
                createElement(SidebarRail),
            ),
        );

        expect(markup).toContain('사이드바 전환');
        expect(markup).not.toContain('Toggle Sidebar');
    });

    test('기본 단축키를 제거하거나 선택적으로 비활성화하지 않는다', () => {
        expect(sidebarSource).toContain('event.key === SIDEBAR_KEYBOARD_SHORTCUT');
        expect(sidebarSource).not.toContain('keyboardShortcut?: string | null');
        expect(sidebarSource).not.toContain('if (!keyboardShortcut) return');
    });
});
