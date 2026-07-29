import type {LocalDashboardSnapshot} from './local-dashboard.ts';

export interface HomeTaskVisibility {
    mealAlerts: number;
    count: number;
}

export function resolveHomeTasks(
    dashboard: LocalDashboardSnapshot,
): HomeTaskVisibility {
    const mealAlerts = dashboard.mealAlerts.length;

    return {
        mealAlerts,
        count: mealAlerts,
    };
}
