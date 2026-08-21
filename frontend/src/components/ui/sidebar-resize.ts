export type SidebarSide = 'left' | 'right';

const SIDEBAR_RESIZE_STEP = 8;

function clampSidebarWidth(width: number, minWidth: number, maxWidth: number): number {
    return Math.min(Math.max(width, minWidth), maxWidth);
}

export function sidebarWidthFromPointer({
    clientX,
    viewportWidth,
    side,
    minWidth,
    maxWidth,
}: {
    clientX: number;
    viewportWidth: number;
    side: SidebarSide;
    minWidth: number;
    maxWidth: number;
}): number {
    const width = side === 'left' ? clientX : viewportWidth - clientX;
    return clampSidebarWidth(width, minWidth, maxWidth);
}

export function sidebarWidthFromKeyboard(
    currentWidth: number,
    key: string,
    side: SidebarSide,
    minWidth: number,
    maxWidth: number,
): number {
    if (key === 'Home') return minWidth;
    if (key === 'End') return maxWidth;

    const direction = side === 'left' ? 1 : -1;
    if (key === 'ArrowRight') {
        return clampSidebarWidth(
            currentWidth + SIDEBAR_RESIZE_STEP * direction,
            minWidth,
            maxWidth,
        );
    }
    if (key === 'ArrowLeft') {
        return clampSidebarWidth(
            currentWidth - SIDEBAR_RESIZE_STEP * direction,
            minWidth,
            maxWidth,
        );
    }

    return clampSidebarWidth(currentWidth, minWidth, maxWidth);
}
