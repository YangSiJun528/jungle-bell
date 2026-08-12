import {type PropsWithChildren, useEffect, useMemo} from 'react';
import {QueryClientProvider, useQueryClient} from '@tanstack/react-query';
import {listen} from '@tauri-apps/api/event';
import type {DesktopConnectionState} from '@/api/dashboard-api';
import {
    normalizeNotificationInboxSnapshot,
    type NotificationInboxSnapshot,
} from '@/domain/notifications/inbox';
import {
    createEnvironment,
    DashboardEnvironmentContext,
    queryKeys,
} from './dashboard-context';
import {
    DashboardAccountProvider,
    normalizeLmsSessionStateEvent,
    withLmsSessionState,
} from './dashboard-account';
import {
    createDesktopSubscriptionRegistry,
    disposeDesktopSubscriptions,
    registerDesktopSubscriptions,
} from './desktop-event-subscriptions';
import {createJungleBellQueryClient} from './query-client';

const queryClient = createJungleBellQueryClient();

function DesktopEventBridge({enabled}: {enabled: boolean}) {
    const client = useQueryClient();

    useEffect(() => {
        if (!enabled) return;
        const registry = createDesktopSubscriptionRegistry();

        void registerDesktopSubscriptions(
            registry,
            [
                () => listen<unknown>('notification-inbox-updated', ({payload}) => {
                    const snapshot = normalizeNotificationInboxSnapshot(payload);
                    if (snapshot) {
                        client.setQueryData<NotificationInboxSnapshot>(queryKeys.notifications('desktop'), snapshot);
                    }
                }),
                () => listen<unknown>('lms-session-state-updated', ({payload}) => {
                    const state = normalizeLmsSessionStateEvent(payload);
                    if (!state) return;
                    void client.invalidateQueries({queryKey: queryKeys.desktopSettings});
                    const current = client.getQueryData<DesktopConnectionState>(queryKeys.desktopConnection);
                    if (current) {
                        client.setQueryData(
                            queryKeys.desktopConnection,
                            withLmsSessionState(current, state),
                        );
                    } else {
                        void client.invalidateQueries({queryKey: queryKeys.desktopConnection});
                    }
                }),
            ],
        ).catch(() => undefined);

        return () => disposeDesktopSubscriptions(registry);
    }, [client, enabled]);

    return null;
}

export function DashboardProviders({children}: PropsWithChildren) {
    const environment = useMemo(createEnvironment, []);
    return (
        <QueryClientProvider client={queryClient}>
            <DashboardEnvironmentContext.Provider value={environment}>
                <DashboardAccountProvider>
                    <DesktopEventBridge enabled={environment.runtime.runningInTauri}/>
                    {children}
                </DashboardAccountProvider>
            </DashboardEnvironmentContext.Provider>
        </QueryClientProvider>
    );
}
