import {useCallback, useSyncExternalStore} from 'react';
import type {DashboardRoute, DashboardSurfaceKind} from '@/dashboard-model';
import {dashboardRouteFromHash, dashboardRouteHref} from './routes';

function subscribe(callback: () => void): () => void {
    window.addEventListener('hashchange', callback);
    return () => window.removeEventListener('hashchange', callback);
}

function currentHash(): string {
    return window.location.hash;
}

export function useHashRoute(surface: DashboardSurfaceKind): {
    route: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
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
    return {route, navigate};
}
