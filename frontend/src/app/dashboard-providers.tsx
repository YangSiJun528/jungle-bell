import {type PropsWithChildren, useEffect, useMemo} from 'react';
import {QueryClientProvider, useQueryClient} from '@tanstack/react-query';
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
    normalizeLmsSessionStateEvent,
    withLmsSessionState,
} from './dashboard-account-state';
import {DashboardAccountProvider} from './dashboard-account';
import {
    createDesktopSubscriptionRegistry,
    disposeDesktopSubscriptions,
    registerDesktopSubscriptions,
} from '@/platform/event-subscriptions';
import type {PlatformAdapter} from '@/platform/contracts';
import {createJungleBellQueryClient} from './query-client';
import {handleAttendanceSnapshotUpdated} from './desktop-attendance-event';
import {DesktopUpdateGate} from './desktop-update-gate';

const queryClient = createJungleBellQueryClient();

function PlatformEventBridge({platform}: {platform: PlatformAdapter}) {
    const client = useQueryClient();

    useEffect(() => {
        if (!platform.events.enabled) return;
        const registry = createDesktopSubscriptionRegistry();

        void registerDesktopSubscriptions(
            registry,
            [
                () => platform.events.subscribeNotificationInboxUpdated((payload) => {
                    const snapshot = normalizeNotificationInboxSnapshot(payload);
                    if (snapshot) {
                        client.setQueryData<NotificationInboxSnapshot>(queryKeys.notifications('desktop'), snapshot);
                    }
                }),
                () => platform.events.subscribeAttendanceSnapshotUpdated((payload) => {
                    void handleAttendanceSnapshotUpdated(client, payload);
                }),
                () => platform.events.subscribeLmsSessionStateUpdated((payload) => {
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
    }, [client, platform]);

    return null;
}

export function DashboardProviders({children, platform}: PropsWithChildren<{platform: PlatformAdapter}>) {
    const environment = useMemo(() => createEnvironment(platform), [platform]);
    return (
        <QueryClientProvider client={queryClient}>
            <DashboardEnvironmentContext.Provider value={environment}>
                <DesktopUpdateGate>
                    <DashboardAccountProvider>
                        <PlatformEventBridge platform={platform}/>
                        {children}
                    </DashboardAccountProvider>
                </DesktopUpdateGate>
            </DashboardEnvironmentContext.Provider>
        </QueryClientProvider>
    );
}
