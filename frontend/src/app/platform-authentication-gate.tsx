import {useMutation} from '@tanstack/react-query';
import {Link, useRouterState} from '@tanstack/react-router';
import {CircleAlert, Download, LogIn, RefreshCw, Smartphone} from 'lucide-react';
import {type PropsWithChildren, type ReactNode, useEffect, useId, useReducer} from 'react';

import {PageHeader} from '@/components/dashboard/page-header';
import {Button} from '@/components/ui/button';

import {useDashboardAccount} from './dashboard-account';
import {
    CHECKER_LMS_UNKNOWN_TIMEOUT_MS,
    checkerWaitTransition,
    initialCheckerWaitState,
    type LmsAuthenticationStatus,
    type PersonalAccessState,
    type ServerSessionStatus,
} from './dashboard-account-state';
import {useDashboardEnvironment} from './dashboard-context';
import {
    connectionsRouteSearch,
    DASHBOARD_ROUTE_META,
    dashboardRouteFromPath,
    normalizeDashboardReturnTarget,
    type DashboardReturnTarget,
} from './routes';
import {useRefreshAttendanceMutation} from './use-dashboard-queries';

interface PlatformAuthenticationGateProps extends PropsWithChildren {
    enabled?: boolean;
    preserveRouteHeading?: boolean;
    timeoutMilliseconds?: number;
}

interface GatePanelProps {
    actions: ReactNode;
    description: string;
    icon: ReactNode;
    title: string;
    tone?: 'default' | 'destructive';
}

function GatePanel({actions, description, icon, title, tone = 'default'}: GatePanelProps) {
    const titleId = useId();
    return (
        <section
            aria-labelledby={titleId}
            className={`rounded-xl border p-5 ${
                tone === 'destructive'
                    ? 'border-destructive/30 bg-destructive/5'
                    : 'bg-card text-card-foreground'
            }`}
            data-personal-access-gate="true"
        >
            <div className="flex items-start gap-3">
                <span className="mt-0.5 text-muted-foreground">{icon}</span>
                <div className="min-w-0 flex-1">
                    <h2 className="font-semibold" id={titleId}>
                        {title}
                    </h2>
                    <p className="mt-2 text-base leading-6 text-muted-foreground">{description}</p>
                    <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
                </div>
            </div>
        </section>
    );
}

function PersonalGateRouteFrame({children, pathname}: PropsWithChildren<{pathname: string}>) {
    const route = dashboardRouteFromPath(pathname);
    return (
        <div className="space-y-6" data-personal-access-route-frame="true">
            <PageHeader title={DASHBOARD_ROUTE_META[route].label} />
            {children}
        </div>
    );
}

function PublicHomeAction() {
    return (
        <Button asChild size="sm" variant="ghost">
            <Link to="/home">공개 홈으로 나가기</Link>
        </Button>
    );
}

function DeviceSettingsAction({returnTo}: {returnTo?: DashboardReturnTarget}) {
    return (
        <Button asChild size="sm" variant="outline">
            <Link to="/connections" search={connectionsRouteSearch('devices', returnTo)}>
                기기 연결 열기
            </Link>
        </Button>
    );
}

function LoginAction({
    error,
    pending,
    start,
}: {
    error: boolean;
    pending: boolean;
    start: () => void;
}) {
    return (
        <>
            <Button disabled={pending} size="sm" onClick={start}>
                <LogIn aria-hidden="true" />
                {pending ? '여는 중' : 'LMS 로그인 창 열기'}
            </Button>
            {error ? (
                <p className="w-full text-sm text-destructive" role="alert">
                    LMS 로그인 창을 열지 못했습니다. 다시 시도하세요.
                </p>
            ) : null}
        </>
    );
}

function RetryAction({fetching, retry}: {fetching: boolean; retry: () => void}) {
    return (
        <Button disabled={fetching} size="sm" variant="outline" onClick={retry}>
            <RefreshCw aria-hidden="true" />
            {fetching ? '확인 중' : '상태 다시 확인'}
        </Button>
    );
}

function WebPersonalGate() {
    return (
        <GatePanel
            icon={<Download aria-hidden="true" className="size-5" />}
            title="앱 설치가 필요합니다."
            description="출석과 개인 알림은 PC 앱 또는 홈 화면에 설치한 PWA에서 사용할 수 있습니다. 앱 설치 안내를 확인하세요."
            actions={
                <>
                    <Button asChild size="sm">
                        <Link to="/install">앱 설치 안내</Link>
                    </Button>
                    <PublicHomeAction />
                </>
            }
        />
    );
}

function BrowserPersonalGate({
    access,
    fetching,
    retry,
    returnTo,
}: {
    access: PersonalAccessState;
    fetching: boolean;
    retry: () => void;
    returnTo?: DashboardReturnTarget;
}) {
    if (access.status === 'checking') {
        return (
            <GatePanel
                icon={<RefreshCw aria-hidden="true" className="size-5 animate-spin" />}
                title="PC 연결 상태를 확인하고 있습니다."
                description="연결 확인이 끝나면 이 화면에서 개인 기능을 바로 엽니다. 오래 걸리면 기기 연결 상태를 확인하세요."
                actions={
                    <>
                        <DeviceSettingsAction returnTo={returnTo} />
                        <PublicHomeAction />
                    </>
                }
            />
        );
    }
    if (access.status === 'error') {
        const offline = access.reason === 'offline';
        return (
            <GatePanel
                tone="destructive"
                icon={<CircleAlert aria-hidden="true" className="size-5" />}
                title={
                    offline
                        ? '오프라인이라 PC 연결을 확인할 수 없습니다.'
                        : '서버 오류로 PC 연결을 확인하지 못했습니다.'
                }
                description={
                    offline
                        ? '인터넷 연결을 확인한 뒤 다시 시도하세요. 공개 화면은 계속 사용할 수 있습니다.'
                        : '잠시 뒤 상태를 다시 확인하세요. 문제가 계속되면 기기 연결 설정에서 연결을 갱신하세요.'
                }
                actions={
                    <>
                        <RetryAction fetching={fetching} retry={retry} />
                        <DeviceSettingsAction returnTo={returnTo} />
                        <PublicHomeAction />
                    </>
                }
            />
        );
    }

    const expired = access.status === 'unconnected' && access.reason === 'expired';
    return (
        <GatePanel
            icon={<Smartphone aria-hidden="true" className="size-5" />}
            title={expired ? 'PC 연결 세션이 만료되었습니다.' : 'PC 앱 최초 연결이 필요합니다.'}
            description={
                expired
                    ? '개인 기능을 다시 사용하려면 기기 연결 탭에서 PC 앱과 재연결하세요. 연결되면 원래 경로로 돌아올 수 있습니다.'
                    : '이 개인 기능은 연결된 PC의 인증을 사용합니다. 기기 연결 탭에서 PC 앱의 연결 코드를 입력하세요.'
            }
            actions={
                <>
                    <DeviceSettingsAction returnTo={returnTo} />
                    <PublicHomeAction />
                </>
            }
        />
    );
}

function DesktopCheckingGate({
    kind,
    loginAction,
    retryAction,
    timedOut,
}: {
    kind: 'lms' | 'server';
    loginAction: ReactNode;
    retryAction: ReactNode;
    timedOut: boolean;
}) {
    const lms = kind === 'lms';
    if (timedOut) {
        return (
            <GatePanel
                tone="destructive"
                icon={<CircleAlert aria-hidden="true" className="size-5" />}
                title={
                    lms
                        ? 'LMS 로그인 확인이 지연되고 있습니다.'
                        : '서버 계정 확인이 지연되고 있습니다.'
                }
                description="checker가 제한 시간 안에 상태를 확인하지 못했습니다. 상태를 다시 확인하거나 LMS 로그인 창을 여세요."
                actions={
                    <>
                        {retryAction}
                        {loginAction}
                        <PublicHomeAction />
                    </>
                }
            />
        );
    }
    return (
        <GatePanel
            icon={<RefreshCw aria-hidden="true" className="size-5 animate-spin" />}
            title={
                lms ? 'LMS 로그인 상태를 확인하고 있습니다.' : '계정 연결 상태를 확인하고 있습니다.'
            }
            description="확인이 끝나면 현재 경로에서 개인 기능을 자동으로 엽니다. 공개 화면은 계속 사용할 수 있습니다."
            actions={
                <>
                    {lms ? loginAction : null}
                    <PublicHomeAction />
                </>
            }
        />
    );
}

function DesktopLmsGate({
    loginAction,
    retryAction,
    status,
    timedOut,
}: {
    loginAction: ReactNode;
    retryAction: ReactNode;
    status: LmsAuthenticationStatus;
    timedOut: boolean;
}) {
    if (status === 'checking') {
        return (
            <DesktopCheckingGate
                kind="lms"
                loginAction={loginAction}
                retryAction={retryAction}
                timedOut={timedOut}
            />
        );
    }
    if (status === 'required') {
        return (
            <GatePanel
                icon={<LogIn aria-hidden="true" className="size-5" />}
                title="LMS 로그인이 필요합니다."
                description="정글 캠퍼스 계정으로 로그인하면 현재 경로에서 개인 기능을 자동으로 엽니다."
                actions={
                    <>
                        {loginAction}
                        <PublicHomeAction />
                    </>
                }
            />
        );
    }
    return (
        <GatePanel
            tone="destructive"
            icon={<CircleAlert aria-hidden="true" className="size-5" />}
            title="LMS 로그인 상태를 확인하지 못했습니다."
            description="네트워크 또는 checker 오류일 수 있습니다. 상태를 다시 확인하거나 LMS 로그인 창을 여세요."
            actions={
                <>
                    {retryAction}
                    {loginAction}
                    <PublicHomeAction />
                </>
            }
        />
    );
}

function DesktopServerGate({
    connect,
    connecting,
    loginAction,
    retryAction,
    returnTo,
    status,
    timedOut,
}: {
    connect: () => void;
    connecting: boolean;
    loginAction: ReactNode;
    retryAction: ReactNode;
    returnTo?: DashboardReturnTarget;
    status: ServerSessionStatus;
    timedOut: boolean;
}) {
    if (status === 'checking') {
        return (
            <DesktopCheckingGate
                kind="server"
                loginAction={loginAction}
                retryAction={retryAction}
                timedOut={timedOut}
            />
        );
    }
    if (status === 'recovery-required') {
        return (
            <GatePanel
                tone="destructive"
                icon={<CircleAlert aria-hidden="true" className="size-5" />}
                title="계정 복구가 필요합니다."
                description="저장된 PC 계정 정보가 일치하지 않습니다. 기기 연결 설정에서 복구 절차를 진행하세요."
                actions={
                    <>
                        <DeviceSettingsAction returnTo={returnTo} />
                        <PublicHomeAction />
                    </>
                }
            />
        );
    }
    if (status === 'missing') {
        return (
            <GatePanel
                icon={<RefreshCw aria-hidden="true" className="size-5" />}
                title="서버 계정 연결이 필요합니다."
                description="LMS 로그인은 확인됐지만 Jungle Bell 서버 계정이 아직 준비되지 않았습니다. 계정 연결을 다시 시도하세요."
                actions={
                    <>
                        <Button disabled={connecting} size="sm" onClick={connect}>
                            <RefreshCw aria-hidden="true" />
                            {connecting ? '연결 중' : '계정 연결 다시 시도'}
                        </Button>
                        <PublicHomeAction />
                    </>
                }
            />
        );
    }
    return (
        <GatePanel
            tone="destructive"
            icon={<CircleAlert aria-hidden="true" className="size-5" />}
            title="서버 계정 상태를 확인하지 못했습니다."
            description="네트워크 또는 서버 오류일 수 있습니다. 상태를 다시 확인하거나 기기 연결 설정에서 복구하세요."
            actions={
                <>
                    {retryAction}
                    <DeviceSettingsAction returnTo={returnTo} />
                    <PublicHomeAction />
                </>
            }
        />
    );
}

export function PlatformAuthenticationGate({
    children,
    enabled = true,
    preserveRouteHeading = false,
    timeoutMilliseconds = CHECKER_LMS_UNKNOWN_TIMEOUT_MS,
}: PlatformAuthenticationGateProps) {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const pathname = useRouterState({select: (state) => state.location.pathname});
    const refreshAttendance = useRefreshAttendanceMutation();
    const [checkerWait, dispatchCheckerWait] = useReducer(
        checkerWaitTransition,
        initialCheckerWaitState,
    );
    // Opening the LMS window does not mutate query-backed application state.
    // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
    const login = useMutation({mutationFn: () => api.openLmsLogin()});
    const desktopChecking =
        enabled &&
        platform.capabilities.desktopAccount &&
        account.personalAccess.status === 'checking';

    useEffect(() => {
        if (!desktopChecking) {
            dispatchCheckerWait({type: 'resolved'});
            return undefined;
        }
        const attempt = checkerWait.attempt;
        const timeout = window.setTimeout(
            () => dispatchCheckerWait({type: 'timeout', attempt}),
            timeoutMilliseconds,
        );
        return () => window.clearTimeout(timeout);
    }, [checkerWait.attempt, desktopChecking, timeoutMilliseconds]);

    if (!enabled || account.personalAccess.status === 'connected') return children;

    const returnTo = normalizeDashboardReturnTarget(pathname);
    const loginAction = (
        <LoginAction error={login.isError} pending={login.isPending} start={() => login.mutate()} />
    );
    const retryDesktop = () => {
        dispatchCheckerWait({type: 'retry'});
        void account.connectionQuery.refetch();
    };
    const retryAction = (
        <RetryAction fetching={account.connectionQuery.isFetching} retry={retryDesktop} />
    );
    const renderGate = (gate: ReactNode) =>
        preserveRouteHeading ? (
            <PersonalGateRouteFrame pathname={pathname}>{gate}</PersonalGateRouteFrame>
        ) : (
            gate
        );

    if (platform.accountAuthentication.kind === 'none') return renderGate(<WebPersonalGate />);
    if (platform.accountAuthentication.kind === 'cookie') {
        return renderGate(
            <BrowserPersonalGate
                access={account.personalAccess}
                fetching={account.browserSessionQuery.isFetching}
                retry={() => void account.browserSessionQuery.refetch()}
                returnTo={returnTo}
            />,
        );
    }
    if (account.status.lmsAuthentication !== 'authenticated') {
        return renderGate(
            <DesktopLmsGate
                loginAction={loginAction}
                retryAction={retryAction}
                status={account.status.lmsAuthentication}
                timedOut={checkerWait.timedOut}
            />,
        );
    }
    return renderGate(
        <DesktopServerGate
            connect={() => refreshAttendance.mutate()}
            connecting={refreshAttendance.isPending}
            loginAction={loginAction}
            retryAction={retryAction}
            returnTo={returnTo}
            status={account.status.serverSession}
            timedOut={checkerWait.timedOut}
        />,
    );
}
