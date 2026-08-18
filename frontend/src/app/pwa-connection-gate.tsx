import type {PropsWithChildren, ReactNode} from 'react';
import jungleBellLogo from '@/assets/logo.png';
import {useDashboardAccount} from './dashboard-account';
import {useDashboardEnvironment} from './dashboard-context';
import {ErrorState, LoadingState} from '@/components/dashboard/async-state';

interface PwaConnectionGateProps extends PropsWithChildren {
    connectionContent: ReactNode;
}

export function PwaConnectionGate({children, connectionContent}: PwaConnectionGateProps) {
    const {platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const installedPwa = platform.accountAuthentication.kind === 'cookie';

    if (!installedPwa || account.personalAccess.status === 'connected') return children;

    let content: ReactNode;
    if (account.personalAccess.status === 'checking') {
        content = <LoadingState label="PC 연결 상태를 확인하고 있습니다."/>;
    } else if (account.personalAccess.status === 'error') {
        content = (
            <ErrorState
                title="PC 연결 상태를 확인하지 못했습니다."
                description="네트워크 상태를 확인한 뒤 다시 시도하세요."
                retry={() => void account.browserSessionQuery.refetch()}
            />
        );
    } else {
        content = (
            <div className="space-y-4">
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
                    <strong>PC 앱 연결이 필요합니다.</strong>
                    <p className="mt-1 text-muted-foreground">
                        연결하기 전에는 Jungle Bell을 사용할 수 없습니다. PC 앱에서 연결 코드를 만든 뒤 아래에서 연결하세요.
                    </p>
                </div>
                {connectionContent}
            </div>
        );
    }

    return (
        <main
            className="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground"
            data-pwa-connection-gate="true"
        >
            <div className="w-full max-w-xl space-y-6">
                <header className="text-center">
                    <img className="mx-auto size-16 rounded-2xl" src={jungleBellLogo} alt="Jungle Bell"/>
                    <h1 className="mt-4 text-2xl font-bold">Jungle Bell 연결</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        설치형 PWA는 연결된 PC의 인증과 알림 설정을 사용합니다.
                    </p>
                </header>
                {content}
            </div>
        </main>
    );
}
