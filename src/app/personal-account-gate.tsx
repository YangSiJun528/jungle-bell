import {type PropsWithChildren} from 'react';
import {useMutation} from '@tanstack/react-query';
import {CircleAlert, LogIn, RefreshCw} from 'lucide-react';
import {LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {useDashboardAccount} from './dashboard-account';
import {useDashboardEnvironment} from './dashboard-context';
import {useRefreshAttendanceMutation} from './use-dashboard-queries';

export function PersonalAccountGate({children}: PropsWithChildren) {
    const {api, surface} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const refresh = useRefreshAttendanceMutation();
    const login = useMutation({mutationFn: () => api.openLmsLogin()});

    if (surface.kind !== 'desktop') return children;

    if (account.status.lmsAuthentication === 'checking') {
        return <LoadingState label="LMS 로그인 상태를 확인하고 있습니다."/>;
    }
    if (account.status.lmsAuthentication === 'required') {
        return (
            <Alert className="border-amber-500/25 bg-amber-500/10 text-amber-950 dark:text-amber-100">
                <LogIn aria-hidden="true"/>
                <AlertTitle>LMS 로그인이 필요합니다.</AlertTitle>
                <AlertDescription>
                    <Button className="mt-2" disabled={login.isPending} size="sm" onClick={() => login.mutate()}>
                        {login.isPending ? '여는 중' : 'LMS 로그인'}
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }
    if (account.status.lmsAuthentication === 'unavailable') {
        return (
            <Alert variant="destructive">
                <CircleAlert aria-hidden="true"/>
                <AlertTitle>LMS 로그인 상태를 확인하지 못했습니다.</AlertTitle>
                <AlertDescription>
                    <Button size="sm" variant="outline" onClick={() => void account.connectionQuery.refetch()}>
                        새로고침
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }
    if (account.status.serverSession === 'checking') {
        return <LoadingState label="계정 연결 상태를 확인하고 있습니다."/>;
    }
    if (account.status.serverSession === 'recovery-required') {
        return (
            <Alert variant="destructive">
                <CircleAlert aria-hidden="true"/>
                <AlertTitle>계정 복구가 필요합니다.</AlertTitle>
                <AlertDescription>
                    <Button asChild className="mt-2" size="sm" variant="outline">
                        <a href="#connections">연결 설정</a>
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }
    if (account.status.serverSession === 'missing') {
        return (
            <Alert>
                <RefreshCw aria-hidden="true"/>
                <AlertTitle>계정 연결이 필요합니다.</AlertTitle>
                <AlertDescription>
                    <Button className="mt-2" disabled={refresh.isPending} size="sm" onClick={() => refresh.mutate()}>
                        {refresh.isPending ? '연결 중' : '계정 연결'}
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    return children;
}
