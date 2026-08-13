export interface DashboardRuntimeSignals {
    hasTauriInternals: boolean;
}

export interface DashboardRuntime {
    runningInTauri: boolean;
}

interface DashboardRuntimeWindow {
    [key: string]: unknown;
}

export function dashboardRuntimeFromSignals(
    signals: DashboardRuntimeSignals,
): DashboardRuntime {
    return {
        runningInTauri: signals.hasTauriInternals,
    };
}

export function detectDashboardRuntime(
    windowObject: DashboardRuntimeWindow = window as unknown as DashboardRuntimeWindow,
): DashboardRuntime {
    return dashboardRuntimeFromSignals({
        hasTauriInternals: '__TAURI_INTERNALS__' in windowObject,
    });
}
