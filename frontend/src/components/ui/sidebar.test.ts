import {readFileSync} from 'node:fs';

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test} from 'vitest';

import {SidebarProvider, SidebarRail, SidebarTrigger} from './sidebar';
import {sidebarWidthFromKeyboard, sidebarWidthFromPointer} from './sidebar-resize';

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

    test('Rail 드래그 옵션은 포인터 방향과 허용 폭을 반영한다', () => {
        expect(
            sidebarWidthFromPointer({
                clientX: 280,
                maxWidth: 384,
                minWidth: 192,
                side: 'left',
                viewportWidth: 1180,
            }),
        ).toBe(280);
        expect(
            sidebarWidthFromPointer({
                clientX: 900,
                maxWidth: 384,
                minWidth: 192,
                side: 'right',
                viewportWidth: 1180,
            }),
        ).toBe(280);
        expect(
            sidebarWidthFromPointer({
                clientX: 30,
                maxWidth: 384,
                minWidth: 192,
                side: 'left',
                viewportWidth: 1180,
            }),
        ).toBe(192);
        expect(
            sidebarWidthFromPointer({
                clientX: 800,
                maxWidth: 384,
                minWidth: 192,
                side: 'left',
                viewportWidth: 1180,
            }),
        ).toBe(384);
    });

    test('키보드 방향키도 Sidebar 방향에 맞게 폭을 조절한다', () => {
        expect(sidebarWidthFromKeyboard(256, 'ArrowRight', 'left', 192, 384)).toBe(264);
        expect(sidebarWidthFromKeyboard(256, 'ArrowLeft', 'left', 192, 384)).toBe(248);
        expect(sidebarWidthFromKeyboard(256, 'ArrowRight', 'right', 192, 384)).toBe(248);
        expect(sidebarWidthFromKeyboard(256, 'Home', 'left', 192, 384)).toBe(192);
        expect(sidebarWidthFromKeyboard(256, 'End', 'left', 192, 384)).toBe(384);
    });

    test('resizable Provider는 Rail을 크기 조절 핸들로 노출한다', () => {
        const markup = renderToStaticMarkup(
            createElement(SidebarProvider, {resizable: true}, createElement(SidebarRail)),
        );

        expect(markup).toContain('data-sidebar-resizable="true"');
        expect(markup).toContain('data-resizable="true"');
        expect(markup).toContain('aria-label="사이드바 크기 조절"');
        expect(markup).toContain('tabindex="0"');
        expect(sidebarSource).toContain("window.addEventListener('pointermove'");
        expect(sidebarSource).toContain("window.addEventListener('pointerup'");
    });
});
