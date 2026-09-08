import {useEffect, useRef} from 'react';

import {DASHBOARD_ROUTE_META, dashboardRouteFromPath} from './routes';

export function dashboardDocumentTitle(pathname: string): string {
    if (pathname === '/privacy') return '개인정보 처리방침 · Jungle Bell';
    return `${DASHBOARD_ROUTE_META[dashboardRouteFromPath(pathname)].label} · Jungle Bell`;
}

export function focusDashboardHeading(documentObject: Document = document): boolean {
    const heading = documentObject.querySelector<HTMLElement>(
        '#dashboard-content h1, main h1, [data-desktop-update-gate] h1',
    );
    if (!heading) return false;
    heading.tabIndex = -1;
    heading.focus({preventScroll: true});
    return true;
}

export function DashboardRouteAccessibility({pathname}: {pathname: string}) {
    const previousPathname = useRef(pathname);

    useEffect(() => {
        document.title = dashboardDocumentTitle(pathname);
        if (previousPathname.current === pathname || pathname === '/notifications')
            return undefined;
        previousPathname.current = pathname;

        let frame = 0;
        let observer: MutationObserver | null = null;
        let timeout = 0;
        frame = window.requestAnimationFrame(() => {
            if (focusDashboardHeading()) return;
            observer = new MutationObserver(() => {
                if (focusDashboardHeading()) observer?.disconnect();
            });
            observer.observe(document.body, {childList: true, subtree: true});
            timeout = window.setTimeout(() => observer?.disconnect(), 2_000);
        });

        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
            observer?.disconnect();
        };
    }, [pathname]);

    return null;
}
