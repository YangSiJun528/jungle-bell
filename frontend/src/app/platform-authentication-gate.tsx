import type {PropsWithChildren, ReactNode} from 'react';
import {useMutation} from '@tanstack/react-query';
import {CircleAlert, LogIn, RefreshCw} from 'lucide-react';
import jungleBellLogo from '@/assets/logo.png';
import {ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {useDashboardAccount} from './dashboard-account';
import {useDashboardEnvironment} from './dashboard-context';

interface PlatformAuthenticationGateProps extends PropsWithChildren {
    connectionContent: ReactNode;
    notice?: ReactNode;
}

function GateFrame({title, description, notice, children}: PropsWithChildren<{
    title: string;
    description: string;
    notice?: ReactNode;
}>) {
    return (
        <main
            className="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground"
            data-authentication-gate="true"
        >
            <div className="w-full max-w-xl space-y-6">
                {notice}
                <header className="text-center">
                    <img className="mx-auto size-16 rounded-2xl" src={jungleBellLogo} alt="Jungle Bell"/>
                    <h1 className="mt-4 text-2xl font-bold">{title}</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
                </header>
                {children}
            </div>
        </main>
    );
}

export function PlatformAuthenticationGate({children, connectionContent, notice}: PlatformAuthenticationGateProps) {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const login = useMutation({mutationFn: () => api.openLmsLogin()});

    if (platform.accountAuthentication.kind === 'none') return children;

    if (platform.accountAuthentication.kind === 'cookie') {
        if (account.personalAccess.status === 'connected') return children;

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
            <GateFrame
                title="Jungle Bell 연결"
                description="설치형 PWA는 연결된 PC의 인증과 알림 설정을 사용합니다."
                notice={notice}
            >
                {content}
            </GateFrame>
        );
    }

    if (account.status.lmsAuthentication === 'authenticated') return children;

    const openLoginButton = (
        <Button disabled={login.isPending} onClick={() => login.mutate()}>
            <LogIn aria-hidden="true"/>
            {login.isPending ? '여는 중' : 'LMS 로그인 창 열기'}
        </Button>
    );
    let content: ReactNode;
    if (account.status.lmsAuthentication === 'required') {
        content = (
            <Alert className="border-amber-500/25 bg-amber-500/10 text-amber-950 dark:text-amber-100">
                <LogIn aria-hidden="true"/>
                <AlertTitle>LMS 로그인이 필요합니다.</AlertTitle>
                <AlertDescription>
                    <p>정글 캠퍼스 계정으로 로그인하면 현재 화면으로 자동 복귀합니다.</p>
                    <div className="mt-3">{openLoginButton}</div>
                </AlertDescription>
            </Alert>
        );
    } else if (account.status.lmsAuthentication === 'unavailable') {
        content = (
            <Alert variant="destructive">
                <CircleAlert aria-hidden="true"/>
                <AlertTitle>LMS 로그인 상태를 확인하지 못했습니다.</AlertTitle>
                <AlertDescription>
                    <p>네트워크 상태를 확인한 뒤 상태를 다시 조회하거나 LMS 로그인 창을 여세요.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                            disabled={account.connectionQuery.isFetching}
                            size="sm"
                            variant="outline"
                            onClick={() => void account.connectionQuery.refetch()}
                        >
                            <RefreshCw aria-hidden="true"/>
                            {account.connectionQuery.isFetching ? '확인 중' : '상태 다시 확인'}
                        </Button>
                        {openLoginButton}
                    </div>
                </AlertDescription>
            </Alert>
        );
    } else {
        content = (
            <div className="space-y-4">
                <LoadingState label="LMS 로그인 상태를 확인하고 있습니다."/>
                <div className="flex justify-center">{openLoginButton}</div>
            </div>
        );
    }

    return (
        <GateFrame
            title="Jungle Bell 인증"
            description="PC 앱은 LMS 로그인이 확인된 뒤 대시보드를 엽니다."
            notice={notice}
        >
            {content}
            {login.isError ? (
                <p className="text-center text-sm text-destructive">LMS 로그인 창을 열지 못했습니다.</p>
            ) : null}
        </GateFrame>
    );
}
