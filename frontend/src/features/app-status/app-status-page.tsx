import {useQuery} from '@tanstack/react-query';
import {
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    LoaderCircle,
    TriangleAlert,
    type LucideIcon,
} from 'lucide-react';

import {useDashboardAccount} from '@/app/dashboard-account';
import {serverSessionReady} from '@/app/dashboard-account-state';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {useDesktopUpdateQuery} from '@/app/desktop-update-query';
import {useAttendanceQuery} from '@/app/use-dashboard-queries';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';

import {
    appStatusRows,
    type AppStatusInput,
    type AppStatusRowModel,
    type AppStatusTab,
    type AppStatusValue,
    type DesktopAppStatusInput,
    type DesktopUpdateState,
    type PwaAppStatusInput,
} from './app-status-model';

const STATUS_PRESENTATION: Record<AppStatusValue, {badgeClassName: string; icon: LucideIcon}> = {
    ready: {
        badgeClassName:
            'border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
        icon: CheckCircle2,
    },
    attention: {
        badgeClassName: 'border-amber-600/25 bg-amber-500/10 text-amber-900 dark:text-amber-100',
        icon: TriangleAlert,
    },
    checking: {
        badgeClassName: 'border-sky-600/25 bg-sky-500/10 text-sky-800 dark:text-sky-200',
        icon: LoaderCircle,
    },
    error: {
        badgeClassName: 'border-destructive/25 bg-destructive/10 text-destructive',
        icon: CircleAlert,
    },
    unavailable: {
        badgeClassName: 'border-border bg-muted text-muted-foreground',
        icon: CircleHelp,
    },
};

const SURFACE_DESCRIPTION: Record<AppStatusInput['surface'], string> = {
    desktop: 'PC 로그인, 서버 연결, 동기화와 연결된 기기 상태를 확인합니다.',
    pwa: '현재 PWA 세션과 알림 준비 상태를 확인합니다.',
    web: '일반 웹에서 사용할 수 있는 기능과 PWA 설치 상태를 확인합니다.',
};

export interface AppStatusPageProps {
    input?: AppStatusInput;
    onOpenTab?: (tab: 'notifications' | 'devices') => void;
}

interface AppStatusRowProps {
    onOpenTab?: (tab: AppStatusTab) => void;
    row: AppStatusRowModel;
}

export function AppStatusRow({row, onOpenTab}: AppStatusRowProps) {
    const presentation = STATUS_PRESENTATION[row.status];
    const StatusIcon = presentation.icon;
    const statusText = row.status === 'unavailable' ? '확인 불가' : row.statusText;
    const description =
        row.status === 'unavailable' ? '현재 계약에서 확인할 수 없습니다.' : row.description;
    const actionTab = row.action.tab;

    return (
        <li
            data-app-status={row.status}
            className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
        >
            <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <StatusIcon
                        aria-hidden="true"
                        className={row.status === 'checking' ? 'size-4 animate-spin' : 'size-4'}
                    />
                </span>
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{row.label}</h3>
                        <div aria-live="polite" aria-atomic="true">
                            <span
                                className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${presentation.badgeClassName}`}
                            >
                                {statusText}
                            </span>
                        </div>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
                </div>
            </div>
            {actionTab && onOpenTab ? (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenTab(actionTab)}
                >
                    {row.action.label}
                </Button>
            ) : (
                <Button asChild size="sm" variant="outline">
                    <a href={row.action.href}>{row.action.label}</a>
                </Button>
            )}
        </li>
    );
}

export function AppStatusPanel({
    input,
    onOpenTab,
}: Required<Pick<AppStatusPageProps, 'input'>> & Pick<AppStatusPageProps, 'onOpenTab'>) {
    const rows = appStatusRows(input);
    return (
        <section className="space-y-4" aria-labelledby="app-status-title">
            <div>
                <h2 id="app-status-title" className="text-lg font-semibold">
                    앱 상태
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {SURFACE_DESCRIPTION[input.surface]}
                </p>
            </div>
            <Card className="gap-0 overflow-hidden py-0">
                <ul className="divide-y">
                    {rows.map((row) => (
                        <AppStatusRow key={row.id} row={row} onOpenTab={onOpenTab} />
                    ))}
                </ul>
            </Card>
        </section>
    );
}

function desktopLastSyncedAt(
    personalAccess: ReturnType<typeof useDashboardAccount>['personalAccess']['status'],
    attendance: ReturnType<typeof useAttendanceQuery>,
): DesktopAppStatusInput['lastSyncedAt'] {
    if (attendance.data?.state === 'loaded') {
        const value = attendance.data.attendance;
        if (value.status !== 'available') return value.lastSyncedAt;
        if (value.syncState === 'pending') {
            return {kind: 'pending', observedAt: value.lastSyncedAt};
        }
        return value.freshness === 'stale'
            ? {kind: 'stale', observedAt: value.lastSyncedAt}
            : value.lastSyncedAt;
    }
    if (personalAccess !== 'connected') return 'unavailable';
    if (attendance.isPending) return 'checking';
    if (attendance.isError) return 'unavailable';
    return null;
}

function desktopMobileSessionCount(
    personalReady: boolean,
    sessions: ReturnType<typeof useDesktopMobileSessions>,
): DesktopAppStatusInput['mobileSessionCount'] {
    if (sessions.data) return sessions.data.filter(({status}) => status === 'active').length;
    if (!personalReady) return 'unavailable';
    if (sessions.isPending) return 'checking';
    return 'unavailable';
}

type DesktopUpdateQueryState = Pick<
    ReturnType<typeof useDesktopUpdateQuery>['update'],
    'data' | 'dataUpdatedAt' | 'isError' | 'isPending'
>;

export function desktopUpdateState(query: DesktopUpdateQueryState): DesktopUpdateState {
    if (query.data) {
        const checkedAt =
            query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toISOString() : null;
        const {availableVersion, policy, status} = query.data;
        switch (status) {
            case 'checking':
                return {kind: 'checking'};
            case 'failed':
                return {kind: 'error'};
            case 'latest':
                return {kind: 'latest', checkedAt};
            case 'optional':
            case 'mandatory':
            case 'downloading':
            case 'verifying':
            case 'installing':
            case 'restart-required':
                if (availableVersion === null) return {kind: 'latest', checkedAt};
                return {
                    kind: 'available',
                    availableVersion,
                    mandatory: policy === 'mandatory',
                    checkedAt,
                };
        }
    }
    if (query.isError) return {kind: 'error'};
    if (query.isPending) return {kind: 'checking'};
    return {kind: 'unavailable'};
}

function useDesktopMobileSessions(personalReady: boolean) {
    const {api} = useDashboardEnvironment();
    return useQuery({
        queryKey: queryKeys.mobileSessions,
        queryFn: () => api.listMobileSessions(),
        enabled: personalReady,
        staleTime: 60_000,
        refetchInterval: 60_000,
    });
}

function ConnectedDesktopStatus({onOpenTab}: Pick<AppStatusPageProps, 'onOpenTab'>) {
    const account = useDashboardAccount();
    const personalReady =
        account.status.lmsAuthentication === 'authenticated' && serverSessionReady(account.status);
    const attendance = useAttendanceQuery();
    const sessions = useDesktopMobileSessions(personalReady);
    const {update} = useDesktopUpdateQuery();
    const input: DesktopAppStatusInput = {
        surface: 'desktop',
        lmsAuthentication: account.status.lmsAuthentication,
        serverSession: account.status.serverSession,
        lastSyncedAt: desktopLastSyncedAt(account.personalAccess.status, attendance),
        mobileSessionCount: desktopMobileSessionCount(personalReady, sessions),
        update: desktopUpdateState(update),
    };
    return <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
}

function pwaSessionExpiry(
    account: ReturnType<typeof useDashboardAccount>,
): PwaAppStatusInput['sessionExpiresAt'] {
    if (account.browserSessionQuery.data) return account.browserSessionQuery.data.expiresAt;
    if (account.personalAccess.status === 'checking') return 'checking';
    if (account.personalAccess.status === 'error') return 'unavailable';
    return account.personalAccess.status === 'unconnected' ? null : 'unavailable';
}

function ConnectedPwaStatus({onOpenTab}: Pick<AppStatusPageProps, 'onOpenTab'>) {
    const account = useDashboardAccount();
    const input: PwaAppStatusInput = {
        surface: 'pwa',
        personalAccess: account.personalAccess.status,
        sessionExpiresAt: pwaSessionExpiry(account),
        // The platform adapter can start push setup but exposes no read contract for
        // Notification.permission, an existing subscription, or service-worker readiness.
        notificationPermission: 'unavailable',
    };
    return <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
}

function ConnectedAppStatus({onOpenTab}: Pick<AppStatusPageProps, 'onOpenTab'>) {
    const {platform} = useDashboardEnvironment();
    if (platform.kind === 'desktop') return <ConnectedDesktopStatus onOpenTab={onOpenTab} />;
    if (platform.accountAuthentication.kind === 'cookie') {
        return <ConnectedPwaStatus onOpenTab={onOpenTab} />;
    }
    return (
        <AppStatusPanel
            input={{
                surface: 'web',
                installSupported: platform.capabilities.pwaInstall && platform.pwa.available,
                installed: platform.pwa.installed,
            }}
            onOpenTab={onOpenTab}
        />
    );
}

export function AppStatusPage({input, onOpenTab}: AppStatusPageProps) {
    if (input) return <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
    return <ConnectedAppStatus onOpenTab={onOpenTab} />;
}
