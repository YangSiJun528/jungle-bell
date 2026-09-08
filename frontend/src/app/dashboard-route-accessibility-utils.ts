import {DASHBOARD_ROUTE_META, dashboardRouteFromPath} from './routes';

export function dashboardDocumentTitle(pathname: string): string {
    if (pathname === '/privacy') return '개인정보 처리방침 · Jungle Bell';
    return `${DASHBOARD_ROUTE_META[dashboardRouteFromPath(pathname)].label} · Jungle Bell`;
}

export function dashboardHeadingLabel(pathname: string): string {
    if (pathname === '/privacy') return '개인정보 처리방침';
    return DASHBOARD_ROUTE_META[dashboardRouteFromPath(pathname)].label;
}

export function focusDashboardHeading(
    documentObject: Document = document,
    expectedLabel?: string,
): boolean {
    const headings = documentObject.querySelectorAll<HTMLElement>(
        '#dashboard-content h1, main h1, [data-desktop-update-gate] h1',
    );
    const heading = [...headings].find(
        (candidate) => !expectedLabel || candidate.textContent?.trim() === expectedLabel,
    );
    if (!heading) return false;
    heading.tabIndex = -1;
    heading.focus({preventScroll: true});
    return true;
}
