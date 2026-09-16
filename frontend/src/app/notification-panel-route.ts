import type {DashboardRoute} from '@/navigation/routes';

export type DashboardContentRoute = Exclude<DashboardRoute, 'notifications'>;

export function notificationPanelBackgroundRoute(
    previousRoute: DashboardContentRoute,
    route: DashboardRoute,
): DashboardContentRoute {
    return route === 'notifications' ? previousRoute : route;
}
