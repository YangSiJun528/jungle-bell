export interface DashboardRuntimeSignals {
    hasTauriInternals: boolean;
    standaloneDisplayMode: boolean;
    iosStandalone: boolean;
}

export interface DashboardRuntime {
    runningInTauri: boolean;
    standalone: boolean;
}

interface DashboardRuntimeWindow {
    matchMedia(query: string): {matches: boolean};
    [key: string]: unknown;
}

interface DashboardRuntimeNavigator {
    standalone?: boolean;
}

export function dashboardRuntimeFromSignals(
    signals: DashboardRuntimeSignals,
): DashboardRuntime {
    return {
        runningInTauri: signals.hasTauriInternals,
        standalone: !signals.hasTauriInternals
            && (signals.standaloneDisplayMode || signals.iosStandalone),
    };
}

export function detectDashboardRuntime(
    windowObject: DashboardRuntimeWindow = window as unknown as DashboardRuntimeWindow,
    navigatorObject: DashboardRuntimeNavigator = navigator as DashboardRuntimeNavigator,
): DashboardRuntime {
    return dashboardRuntimeFromSignals({
        hasTauriInternals: '__TAURI_INTERNALS__' in windowObject,
        standaloneDisplayMode: windowObject.matchMedia('(display-mode: standalone)').matches,
        iosStandalone: navigatorObject.standalone === true,
    });
}
