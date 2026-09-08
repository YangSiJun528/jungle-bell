import type {AttendanceDashboard, MobileSession} from '@/api/dashboard-api';
import type {PersonalAccessStatus} from '@/app/dashboard-account-state';

import type {DesktopAppStatusInput} from './app-status-model';

interface QuerySnapshot<T> {
    data: T | undefined;
    isError: boolean;
    isPending: boolean;
}

export interface DesktopStatusProducer {
    data: unknown;
    isError: boolean;
    isFetching: boolean;
    label: string;
    refetch: () => Promise<unknown>;
}

export function desktopLastSyncedAt(
    personalAccess: PersonalAccessStatus,
    attendance: QuerySnapshot<AttendanceDashboard>,
): DesktopAppStatusInput['lastSyncedAt'] {
    const value = attendance.data?.state === 'loaded' ? attendance.data.attendance : null;
    const degraded = attendance.isError || personalAccess !== 'connected';

    if (degraded) {
        return value?.status === 'available'
            ? {kind: 'stale', observedAt: value.lastSyncedAt}
            : 'unavailable';
    }
    if (value) {
        if (value.status !== 'available') return value.lastSyncedAt;
        if (value.syncState === 'pending') {
            return {kind: 'pending', observedAt: value.lastSyncedAt};
        }
        return value.freshness === 'stale'
            ? {kind: 'stale', observedAt: value.lastSyncedAt}
            : value.lastSyncedAt;
    }
    if (attendance.isPending) return 'checking';
    return null;
}

export function desktopMobileSessionCount(
    personalReady: boolean,
    sessions: QuerySnapshot<readonly Pick<MobileSession, 'status'>[]>,
): DesktopAppStatusInput['mobileSessionCount'] {
    if (!personalReady || sessions.isError) return 'unavailable';
    if (sessions.data) {
        return sessions.data.filter(({status}) => status === 'active').length;
    }
    return sessions.isPending ? 'checking' : 'unavailable';
}

export function failedDesktopStatusProducers(
    producers: readonly DesktopStatusProducer[],
): DesktopStatusProducer[] {
    return producers.filter(({isError}) => isError);
}

export async function retryFailedDesktopStatusProducers(
    producers: readonly DesktopStatusProducer[],
): Promise<void> {
    await Promise.allSettled(
        producers
            .filter(({isError}) => isError)
            .map(({refetch}) => Promise.resolve().then(refetch)),
    );
}
