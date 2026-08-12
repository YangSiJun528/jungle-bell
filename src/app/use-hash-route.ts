import {useCallback, useSyncExternalStore} from 'react';
import type {DashboardRoute, DashboardSurfaceKind} from '@/app/surface';
import {dashboardRouteFromHash, dashboardRouteHref} from './routes';

const DASHBOARD_ROUTE_REPLACED_EVENT = 'jungle-bell:dashboard-route-replaced';

function subscribe(callback: () => void): () => void {
    window.addEventListener('hashchange', callback);
    window.addEventListener(DASHBOARD_ROUTE_REPLACED_EVENT, callback);
    return () => {
        window.removeEventListener('hashchange', callback);
        window.removeEventListener(DASHBOARD_ROUTE_REPLACED_EVENT, callback);
    };
}

function currentHash(): string {
    return window.location.hash;
}

interface DashboardRouteReplaceTarget {
    history: Pick<History, 'state' | 'replaceState'>;
    dispatchEvent: (event: Event) => boolean;
}

export function replaceDashboardRouteHash(
    target: DashboardRouteReplaceTarget,
    route: DashboardRoute,
): void {
    target.history.replaceState(target.history.state, '', dashboardRouteHref(route));
    target.dispatchEvent(new Event(DASHBOARD_ROUTE_REPLACED_EVENT));
}

export function useHashRoute(surface: DashboardSurfaceKind): {
    route: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
    replace: (route: DashboardRoute) => void;
} {
    const hash = useSyncExternalStore(subscribe, currentHash, () => '#home');
    const route = dashboardRouteFromHash(hash, surface);
    const navigate = useCallback((next: DashboardRoute) => {
        const nextHash = dashboardRouteHref(next);
        if (window.location.hash === nextHash) {
            window.scrollTo({top: 0, behavior: 'smooth'});
            return;
        }
        window.location.hash = nextHash;
    }, []);
    const replace = useCallback((next: DashboardRoute) => {
        replaceDashboardRouteHash(window, next);
    }, []);
    return {route, navigate, replace};
}
