import type {DashboardRoute} from './surface';

export type DashboardContentRoute = Exclude<DashboardRoute, 'notifications'>;

export function notificationPanelBackgroundRoute(
    previousRoute: DashboardContentRoute,
    route: DashboardRoute,
): DashboardContentRoute {
    return route === 'notifications' ? previousRoute : route;
}
