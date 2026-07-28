import type {LocalDashboardSnapshot} from './local-dashboard.ts';
import type {SettingsSnapshot} from './settings-state.ts';

export type HomeTaskKind = 'laundry';

export interface HomeTaskSubscriptions {
    laundry: boolean;
}

export interface HomeTaskVisibility {
    laundry: boolean;
    mealAlerts: number;
    count: number;
}

export interface HomeTaskDismissal {
    command: string;
    args: Record<string, unknown>;
}

export function homeTaskSubscriptions(
    snapshot: SettingsSnapshot,
): HomeTaskSubscriptions {
    return {
        laundry: snapshot.laundryWatch !== null,
    };
}

export function resolveHomeTasks(
    dashboard: LocalDashboardSnapshot,
    subscriptions: HomeTaskSubscriptions,
): HomeTaskVisibility {
    const laundry = subscriptions.laundry && dashboard.laundry !== null;
    const mealAlerts = dashboard.mealAlerts.length;

    return {
        laundry,
        mealAlerts,
        count: Number(laundry) + mealAlerts,
    };
}

export function withoutHomeTask(
    subscriptions: HomeTaskSubscriptions,
    kind: HomeTaskKind,
): HomeTaskSubscriptions {
    return {
        ...subscriptions,
        [kind]: false,
    };
}

export function homeTaskDismissal(kind: HomeTaskKind): HomeTaskDismissal {
    switch (kind) {
        case 'laundry':
            return {
                command: 'set_laundry_watch',
                args: {watch: null},
            };
    }
}
