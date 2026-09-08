import {useMutation, useQueryClient} from '@tanstack/react-query';
import type {PropsWithChildren} from 'react';

import jungleBellLogo from '@/assets/logo.png';

import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {desktopUpdateGateDecision} from './desktop-update-gate-decision';
import {DesktopUpdatePanel} from './desktop-update-panel';
import {desktopUpdateInstallMutationKey, useDesktopUpdateQuery} from './desktop-update-query';

function UpdateGateFrame({children}: PropsWithChildren) {
    return (
        <div
            className="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground"
            data-desktop-update-gate="true"
        >
            <div className="w-full max-w-xl space-y-6">
                <header className="text-center">
                    <img
                        className="mx-auto size-16 rounded-2xl"
                        src={jungleBellLogo}
                        alt="Jungle Bell"
                    />
                    <h1 className="mt-4 text-2xl font-bold">Jungle Bell 업데이트</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        PC 앱은 최신 호환 버전을 확인한 뒤 대시보드를 엽니다.
                    </p>
                </header>
                {children}
            </div>
        </div>
    );
}

export function DesktopUpdateGate({children}: PropsWithChildren) {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const {desktop, installMutationPending, update} = useDesktopUpdateQuery();
    const install = useMutation({
        mutationKey: desktopUpdateInstallMutationKey,
        mutationFn: () => api.installDesktopUpdate(),
        onSettled: () => client.invalidateQueries({queryKey: queryKeys.desktopUpdate}),
    });
    // 로그 폴더 열기는 query-backed 애플리케이션 상태를 변경하지 않는다.
    // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
    const openLogs = useMutation({mutationFn: () => api.openLogFolder()});
    const decision = desktopUpdateGateDecision({
        desktop,
        data: update.data,
        queryPending: update.isPending,
        queryError: update.isError,
    });

    if (!desktop) return children;

    return (
        <>
            {decision.renderDashboard ? (
                <div
                    inert={decision.blocked ? true : undefined}
                    aria-hidden={decision.blocked || undefined}
                    className={decision.blocked ? 'pointer-events-none select-none' : undefined}
                    data-desktop-update-content="true"
                >
                    {children}
                </div>
            ) : null}
            {decision.blocked ? (
                <dialog
                    open
                    className="fixed inset-0 z-[100] m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-background p-0"
                    aria-modal="true"
                    aria-label="PC 앱 업데이트"
                >
                    <UpdateGateFrame>
                        <DesktopUpdatePanel
                            status={update.data}
                            checkFailed={update.isError}
                            installFailed={install.isError}
                            installPending={install.isPending || installMutationPending}
                            logFailed={openLogs.isError}
                            onInstall={() => install.mutate()}
                            onCheckAgain={() => void update.refetch()}
                            onOpenLogs={() => openLogs.mutate()}
                        />
                    </UpdateGateFrame>
                </dialog>
            ) : null}
        </>
    );
}
