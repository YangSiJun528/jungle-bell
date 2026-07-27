import type {LocalDashboardSnapshot} from './local-dashboard.ts';
import type {SettingsSnapshot} from './settings-state.ts';

export type HomeTaskKind = 'laundry' | 'meals';

export interface HomeTaskSubscriptions {
    laundry: boolean;
    meals: boolean;
}

export interface HomeTaskVisibility {
    laundry: boolean;
    meals: boolean;
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
        meals: snapshot.mealSubscription,
    };
}

export function resolveHomeTasks(
    dashboard: LocalDashboardSnapshot,
    subscriptions: HomeTaskSubscriptions,
): HomeTaskVisibility {
    const laundry = subscriptions.laundry && dashboard.laundry !== null;
    const meals = subscriptions.meals && dashboard.meals !== null;

    return {
        laundry,
        meals,
        count: Number(laundry) + Number(meals),
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
        case 'meals':
            return {
                command: 'set_meal_subscription_enabled',
                args: {enabled: false},
            };
    }
}
