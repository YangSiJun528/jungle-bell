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
