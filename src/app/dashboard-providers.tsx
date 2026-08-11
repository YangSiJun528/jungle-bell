import {
    type Dispatch,
    type PropsWithChildren,
    useEffect,
    useMemo,
    useReducer,
} from 'react';
import {QueryClientProvider, useQueryClient} from '@tanstack/react-query';
import {listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {
    normalizeNotificationInboxSnapshot,
    type NotificationInboxSnapshot,
} from '@/domain/notifications/inbox';
import {
    campusDataHealthReducer,
    type CampusDataHealthAction,
    type CampusDataKind,
    initialCampusDataHealth,
} from './campus-data-health';
import {
    laundryQueryContract,
    mealsQueryContract,
} from './campus-query-options';
import {
    CampusDataHealthContext,
    createEnvironment,
    DashboardEnvironmentContext,
    queryKeys,
} from './dashboard-context';
import {
    createDesktopSubscriptionRegistry,
    disposeDesktopSubscriptions,
    registerDesktopSubscriptions,
} from './desktop-event-subscriptions';
import {createJungleBellQueryClient} from './query-client';

const queryClient = createJungleBellQueryClient();

function DesktopEventBridge({
    dispatchCampusDataHealth,
    enabled,
}: {
    dispatchCampusDataHealth: Dispatch<CampusDataHealthAction>;
    enabled: boolean;
}) {
    const client = useQueryClient();

    useEffect(() => {
        if (!enabled) return;
        const registry = createDesktopSubscriptionRegistry();

        void registerDesktopSubscriptions(
            registry,
            [
                () => listen<{kind: 'laundry' | 'meals'; snapshot: {data: unknown}}>(
                    'campus-data-updated',
                    ({payload}) => {
                        if (payload.kind === 'laundry') {
                            client.setQueryData(
                                laundryQueryContract.queryKey,
                                laundryQueryContract.parse(payload.snapshot.data),
                            );
                        } else {
                            client.setQueryData(
                                mealsQueryContract.queryKey,
                                mealsQueryContract.parse(payload.snapshot.data),
                            );
                        }
                        dispatchCampusDataHealth({type: 'succeeded', kind: payload.kind});
                    },
                ),
                () => listen<{kind: CampusDataKind; message: string}>(
                    'campus-data-error',
                    ({payload}) => {
                        dispatchCampusDataHealth({
                            type: 'failed',
                            kind: payload.kind,
                            message: payload.message,
                            reportedAt: Date.now(),
                        });
                    },
                ),
                () => listen<unknown>('notification-inbox-updated', ({payload}) => {
                    const snapshot = normalizeNotificationInboxSnapshot(payload);
                    if (snapshot) {
                        client.setQueryData<NotificationInboxSnapshot>(queryKeys.notifications('desktop'), snapshot);
                    }
                }),
            ],
            () => invoke('report_campus_ready'),
        ).catch(() => undefined);

        return () => disposeDesktopSubscriptions(registry);
    }, [client, dispatchCampusDataHealth, enabled]);

    return null;
}

export function DashboardProviders({children}: PropsWithChildren) {
    const environment = useMemo(createEnvironment, []);
    const [campusDataHealth, dispatchCampusDataHealth] = useReducer(
        campusDataHealthReducer,
        initialCampusDataHealth,
    );
    return (
        <QueryClientProvider client={queryClient}>
            <DashboardEnvironmentContext.Provider value={environment}>
                <CampusDataHealthContext.Provider value={campusDataHealth}>
                    <DesktopEventBridge
                        dispatchCampusDataHealth={dispatchCampusDataHealth}
                        enabled={environment.runtime.runningInTauri}
                    />
                    {children}
                </CampusDataHealthContext.Provider>
            </DashboardEnvironmentContext.Provider>
        </QueryClientProvider>
    );
}
