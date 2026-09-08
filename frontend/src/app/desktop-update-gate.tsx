import {useMutation} from '@tanstack/react-query';
import {Download} from 'lucide-react';
import type {PropsWithChildren} from 'react';

import jungleBellLogo from '@/assets/logo.png';
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
        </main>
    );
}

export function DesktopUpdateGate({children}: PropsWithChildren) {
    const {api} = useDashboardEnvironment();
    const {desktop, update} = useDesktopUpdateQuery();
    const install = useMutation({
        mutationFn: () => api.installDesktopUpdate(),
        onSuccess: () => update.refetch(),
    });

    if (
        !desktop ||
        update.isPending ||
        update.isError ||
        !update.data?.mandatory ||
        !update.data.availableVersion
    ) {
        return children;
    }

    return (
        <UpdateGateFrame>
            <Alert className="border-amber-500/25 bg-amber-500/10 text-amber-950 dark:text-amber-100">
                <Download aria-hidden="true" />
                <AlertTitle>PC 앱 업데이트가 필요합니다.</AlertTitle>
                <AlertDescription>
                    <p>
                        현재 v{update.data.currentVersion}에서는 앱을 계속 사용할 수 없습니다. 최신
                        정식 버전 v{update.data.availableVersion}으로 업데이트하세요.
                    </p>
                    {install.isError ? (
                        <p className="text-destructive">
                            업데이트를 설치하지 못했습니다. 잠시 후 다시 시도하세요.
                        </p>
                    ) : null}
                    <Button
                        className="mt-2"
                        disabled={install.isPending}
                        onClick={() => install.mutate()}
                    >
                        <Download aria-hidden="true" />
                        {install.isPending ? '업데이트 중' : '지금 업데이트'}
                    </Button>
                </AlertDescription>
            </Alert>
        </UpdateGateFrame>
    );
}
