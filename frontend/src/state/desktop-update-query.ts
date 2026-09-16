import {useIsMutating, useQuery} from '@tanstack/react-query';

import type {UpdateStatus} from '@/platform/status-model';

import {queryKeys, useDashboardEnvironment} from './dashboard-context';

// 원격 endpoint 갱신은 Rust coordinator가 시간당 한 번 수행한다. UI는 로컬
// IPC cache만 짧게 polling해 새 상태를 늦지 않게 표시한다.
const UPDATE_STATUS_POLL_INTERVAL_MS = 60 * 1_000;
const ACTIVE_UPDATE_POLL_INTERVAL_MS = 250;
const ACTIVE_UPDATE_STATUSES: ReadonlySet<UpdateStatus> = new Set([
    'checking',
    'downloading',
    'verifying',
    'installing',
]);

export const desktopUpdateInstallMutationKey = ['desktop-update', 'install'] as const;

export function desktopUpdatePollInterval(
    status: UpdateStatus | undefined,
    installMutationPending: boolean,
): number {
    return installMutationPending || (status !== undefined && ACTIVE_UPDATE_STATUSES.has(status))
        ? ACTIVE_UPDATE_POLL_INTERVAL_MS
        : UPDATE_STATUS_POLL_INTERVAL_MS;
}

export function useDesktopUpdateQuery() {
    const {api, platform} = useDashboardEnvironment();
    const desktop = platform.kind === 'desktop' && platform.capabilities.desktopSettings;
    const installMutationPending =
        useIsMutating({mutationKey: desktopUpdateInstallMutationKey}) > 0;
    const update = useQuery({
        queryKey: queryKeys.desktopUpdate,
        queryFn: () => api.checkDesktopUpdate(),
        enabled: desktop,
        staleTime: UPDATE_STATUS_POLL_INTERVAL_MS,
        refetchInterval: (query) =>
            desktopUpdatePollInterval(query.state.data?.status, installMutationPending),
    });
    return {desktop, installMutationPending, update};
}
