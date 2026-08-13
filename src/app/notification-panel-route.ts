import type {DashboardRoute} from './routes';

export type DashboardContentRoute = Exclude<DashboardRoute, 'notifications'>;

export function notificationPanelBackgroundRoute(
    previousRoute: DashboardContentRoute,
    route: DashboardRoute,
): DashboardContentRoute {
    return route === 'notifications' ? previousRoute : route;
}
