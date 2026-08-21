import {useQuery} from '@tanstack/react-query';

import {queryKeys, useDashboardEnvironment} from './dashboard-context';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export function useDesktopUpdateQuery() {
    const {api, platform} = useDashboardEnvironment();
    const desktop = platform.kind === 'desktop' && platform.capabilities.desktopSettings;
    const update = useQuery({
        queryKey: queryKeys.desktopUpdate,
        queryFn: () => api.checkDesktopUpdate(),
        enabled: desktop,
        staleTime: UPDATE_CHECK_INTERVAL_MS,
        refetchInterval: UPDATE_CHECK_INTERVAL_MS,
    });
    return {desktop, update};
}
