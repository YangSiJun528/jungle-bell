import type {PropsWithChildren, ReactNode} from 'react';
import {useMutation} from '@tanstack/react-query';
import {CircleAlert, Download, RefreshCw} from 'lucide-react';
import jungleBellLogo from '@/assets/logo.png';
import {LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {useDashboardEnvironment} from './dashboard-context';
import {useDesktopUpdateQuery} from './desktop-update-query';

function UpdateGateFrame({children}: PropsWithChildren) {
    return (
        <main
            className="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground"
            data-desktop-update-gate="true"
        >
            <div className="w-full max-w-xl space-y-6">
                <header className="text-center">
                    <img className="mx-auto size-16 rounded-2xl" src={jungleBellLogo} alt="Jungle Bell"/>
                    <h1 className="mt-4 text-2xl font-bold">Jungle Bell 업데이트</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        PC 앱은 최신 호환 버전을 확인한 뒤 대시보드를 엽니다.
                    </p>
                </header>
                {children}
            </div>
        </main>
    );
}

function UpdateCheckError({retry, retrying}: {retry: () => void; retrying: boolean}) {
    return (
        <Alert variant="destructive">
            <CircleAlert aria-hidden="true"/>
            <AlertTitle>업데이트 정보를 확인하지 못했습니다.</AlertTitle>
            <AlertDescription>
                <p>네트워크 상태를 확인한 뒤 다시 시도하세요.</p>
                <Button className="mt-2" disabled={retrying} size="sm" variant="outline" onClick={retry}>
                    <RefreshCw aria-hidden="true"/>
                    {retrying ? '확인 중' : '다시 확인'}
                </Button>
            </AlertDescription>
        </Alert>
    );
}

export function DesktopUpdateGate({children}: PropsWithChildren) {
    const {api} = useDashboardEnvironment();
    const {desktop, update} = useDesktopUpdateQuery();
    const install = useMutation({
        mutationFn: () => api.installDesktopUpdate(),
        onSuccess: () => update.refetch(),
    });

    if (!desktop) return children;

    let content: ReactNode;
    if (update.isError) {
        content = (
            <UpdateCheckError
                retry={() => void update.refetch()}
                retrying={update.isFetching}
            />
        );
    } else if (update.isPending || !update.data) {
        content = <LoadingState label="최신 버전을 확인하고 있습니다."/>;
    } else if (!update.data.mandatory) {
        return children;
    } else if (!update.data.availableVersion) {
        content = (
            <UpdateCheckError
                retry={() => void update.refetch()}
                retrying={update.isFetching}
            />
        );
    } else {
        content = (
            <Alert className="border-amber-500/25 bg-amber-500/10 text-amber-950 dark:text-amber-100">
                <Download aria-hidden="true"/>
                <AlertTitle>PC 앱 업데이트가 필요합니다.</AlertTitle>
                <AlertDescription>
                    <p>
                        현재 v{update.data.currentVersion}에서는 앱을 계속 사용할 수 없습니다.
                        최신 정식 버전 v{update.data.availableVersion}으로 업데이트하세요.
                    </p>
                    {install.isError ? (
                        <p className="text-destructive">업데이트를 설치하지 못했습니다. 잠시 후 다시 시도하세요.</p>
                    ) : null}
                    <Button className="mt-2" disabled={install.isPending} onClick={() => install.mutate()}>
                        <Download aria-hidden="true"/>
                        {install.isPending ? '업데이트 중' : '지금 업데이트'}
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    return <UpdateGateFrame>{content}</UpdateGateFrame>;
}
