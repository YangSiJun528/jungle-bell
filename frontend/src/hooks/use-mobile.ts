import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

function subscribeToViewport(onStoreChange: () => void): () => void {
    const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    mediaQuery.addEventListener('change', onStoreChange);
    return () => mediaQuery.removeEventListener('change', onStoreChange);
}

function mobileViewportSnapshot(): boolean {
    return window.innerWidth < MOBILE_BREAKPOINT;
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
