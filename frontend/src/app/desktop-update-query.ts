import {useQuery} from '@tanstack/react-query';

import {queryKeys, useDashboardEnvironment} from './dashboard-context';

// 원격 endpoint 갱신은 Rust coordinator가 시간당 한 번 수행한다. UI는 로컬
// IPC cache만 짧게 polling해 새 상태를 늦지 않게 표시한다.
const UPDATE_STATUS_POLL_INTERVAL_MS = 60 * 1_000;

export function useDesktopUpdateQuery() {
    const {api, platform} = useDashboardEnvironment();
    const desktop = platform.kind === 'desktop' && platform.capabilities.desktopSettings;
    const update = useQuery({
        queryKey: queryKeys.desktopUpdate,
        queryFn: () => api.checkDesktopUpdate(),
        enabled: desktop,
        staleTime: UPDATE_STATUS_POLL_INTERVAL_MS,
        refetchInterval: UPDATE_STATUS_POLL_INTERVAL_MS,
    });
    return {desktop, update};
}
