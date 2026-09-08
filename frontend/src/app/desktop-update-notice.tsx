import {useMutation, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {deferOptionalDesktopUpdate, isOptionalDesktopUpdateDeferred} from './desktop-update-later';
import {DesktopUpdatePanel} from './desktop-update-panel';
import {desktopUpdateInstallMutationKey, useDesktopUpdateQuery} from './desktop-update-query';

export function DesktopUpdateNotice() {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const {desktop, installMutationPending, update} = useDesktopUpdateQuery();
    const [deferredVersion, setDeferredVersion] = useState<string | null>(null);
    const install = useMutation({
        mutationKey: desktopUpdateInstallMutationKey,
        mutationFn: () => api.installDesktopUpdate(),
        onSettled: () => client.invalidateQueries({queryKey: queryKeys.desktopUpdate}),
    });
    // 로그 폴더 열기는 query-backed 애플리케이션 상태를 변경하지 않는다.
    // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
    const openLogs = useMutation({mutationFn: () => api.openLogFolder()});
    const status = update.data;
    const availableVersion = status?.availableVersion;
    const optional =
        desktop && status?.policy === 'optional' && typeof availableVersion === 'string';
    const deferred =
        optional &&
        status.status === 'optional' &&
        (deferredVersion === availableVersion || isOptionalDesktopUpdateDeferred(availableVersion));

    if (!optional || deferred) return null;

    return (
        <DesktopUpdatePanel
            compact
            status={status}
            installFailed={install.isError}
            installPending={install.isPending || installMutationPending}
            logFailed={openLogs.isError}
            onInstall={() => install.mutate()}
            onCheckAgain={() => void update.refetch()}
            onOpenLogs={() => openLogs.mutate()}
            onLater={() => {
                const version = status.availableVersion;
                if (!version) return;
                deferOptionalDesktopUpdate(version);
                setDeferredVersion(version);
            }}
        />
    );
}
