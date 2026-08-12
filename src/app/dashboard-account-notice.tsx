import {useMutation} from '@tanstack/react-query';
import {LogIn} from 'lucide-react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {useDashboardAccount} from './dashboard-account';
import {useDashboardEnvironment} from './dashboard-context';

export function DashboardAccountNotice() {
    const {api, surface} = useDashboardEnvironment();
    const {status} = useDashboardAccount();
    const login = useMutation({mutationFn: () => api.openLmsLogin()});

    if (surface.kind !== 'desktop' || status.lmsAuthentication !== 'required') {
        return null;
    }

    return (
        <Alert className="mb-4 border-amber-500/25 bg-amber-500/10 text-amber-950 sm:mb-6 dark:text-amber-100">
            <LogIn aria-hidden="true"/>
            <AlertTitle>LMS 로그인이 필요합니다.</AlertTitle>
            <AlertDescription className="text-current/80">
                <p>출석과 D-Day 확인을 위해서 로그인이 필요합니다.</p>
                <Button
                    className="mt-2"
                    disabled={login.isPending}
                    size="sm"
                    onClick={() => login.mutate()}
                >
                    {login.isPending ? '여는 중' : 'LMS 로그인'}
                </Button>
                {login.isError ? <p className="mt-1 text-destructive">LMS 로그인 화면을 열지 못했습니다.</p> : null}
            </AlertDescription>
        </Alert>
    );
}
