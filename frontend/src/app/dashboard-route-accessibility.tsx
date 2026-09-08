import {useEffect, useRef} from 'react';

import {dashboardDocumentTitle, focusDashboardHeading} from './dashboard-route-accessibility-utils';

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
