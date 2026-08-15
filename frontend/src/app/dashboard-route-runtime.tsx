import {createContext, type PropsWithChildren, useContext} from 'react';
import type {DashboardContentRoute} from './notification-panel-route';

interface DashboardRouteRuntime {
    contentRoute: DashboardContentRoute;
    openInstallPrompt: () => void;
}

const DashboardRouteRuntimeContext = createContext<DashboardRouteRuntime | null>(null);

export function DashboardRouteRuntimeProvider({
    children,
    value,
}: PropsWithChildren<{value: DashboardRouteRuntime}>) {
    return (
        <DashboardRouteRuntimeContext.Provider value={value}>
            {children}
        </DashboardRouteRuntimeContext.Provider>
    );
}

export function useDashboardRouteRuntime(): DashboardRouteRuntime {
    const value = useContext(DashboardRouteRuntimeContext);
    if (!value) throw new Error('DASHBOARD_ROUTE_RUNTIME_REQUIRED');
    return value;
}
