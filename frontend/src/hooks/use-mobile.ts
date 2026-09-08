import * as React from 'react';

export const DESKTOP_SHELL_BREAKPOINT = 1024;

const MOBILE_MEDIA_QUERY = `(max-width: ${DESKTOP_SHELL_BREAKPOINT - 1}px)`;

export function isMobileViewportWidth(viewportWidth: number): boolean {
    return viewportWidth < DESKTOP_SHELL_BREAKPOINT;
}

function subscribeToViewport(onStoreChange: () => void): () => void {
    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    mediaQuery.addEventListener('change', onStoreChange);
    return () => mediaQuery.removeEventListener('change', onStoreChange);
}

function mobileViewportSnapshot(): boolean {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function serverMobileViewportSnapshot(): boolean {
    return false;
}

export function useIsMobile() {
    return React.useSyncExternalStore(
        subscribeToViewport,
        mobileViewportSnapshot,
        serverMobileViewportSnapshot,
    );
}
