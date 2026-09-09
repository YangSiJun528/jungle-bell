import {useMutation} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {
    ArrowRight,
    CalendarCheck,
    Check,
    ExternalLink as ExternalLinkIcon,
    RefreshCw,
    X,
} from 'lucide-react';

import type {AttendanceData, AttendanceSnapshot} from '@/api/dashboard-api';
import {useDashboardAccount} from '@/app/dashboard-account';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {useAttendanceQuery, useRefreshAttendanceMutation} from '@/app/use-dashboard-queries';
import {DdayCard} from '@/components/dashboard/dday-card';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardFooter, CardHeader} from '@/components/ui/card';
import {ExternalLink} from '@/components/ui/external-link';
import {Skeleton} from '@/components/ui/skeleton';
import {selectDdayView} from '@/domain/attendance/dday-view';
import {dateTimeLabel} from '@/lib/format';

import {
    resolveCampusAccessState,
    resolveCampusAttendanceContentState,
    type BrowserAccessStatus,
    type CampusAccessState,
    type CampusAttendanceContentState,
    type DesktopAccessStatus,
} from './jungle-campus-summary-state';

const CAMPUS_URL = 'https://jungle-lms.krafton.com/check-in';

function AttendanceCheck({label, checked}: {label: string; checked: boolean}) {
    return (
        <div
            className={
                checked
                    ? 'flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-emerald-700 dark:text-emerald-300'
                    : 'flex items-center gap-2 rounded-lg bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300'
            }
        >
            {checked ? (
                <Check aria-hidden="true" className="size-4" />
            ) : (
                <X aria-hidden="true" className="size-4" />
            )}
            <span className="text-sm">
                <strong>{label}</strong> {checked ? '완료' : '미완료'}
            </span>
        </div>
    );
}

function AttendanceChecks({snapshot}: {snapshot: AttendanceSnapshot}) {
    return (
        <div className="grid grid-cols-2 gap-2" aria-label="오늘 출석 상태">
            <AttendanceCheck label="학습 시작" checked={snapshot.morningChecked} />
            <AttendanceCheck label="학습 종료" checked={snapshot.eveningChecked} />
        </div>
    );
}

function CampusCardFrame({children, footer}: {children: React.ReactNode; footer: React.ReactNode}) {
    return (
        <Card
            className="h-60 gap-0 overflow-hidden border-primary/20 py-0"
            data-home-campus-card="true"
        >
            <CardHeader className="min-h-16 shrink-0 px-5 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <span
                        className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
                        data-home-campus-status-icon="true"
                    >
                        <CalendarCheck aria-hidden="true" className="size-5" />
                    </span>
                    <div className="min-w-0">
                        <h2 className="leading-none font-semibold">정글캠퍼스</h2>
                    </div>
                </div>
            </CardHeader>
            <CardContent
                aria-label="정글캠퍼스 출석 요약"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3 sm:px-6"
                tabIndex={0}
            >
                <div className="flex min-h-full flex-col justify-center gap-3">{children}</div>
            </CardContent>
            <CardFooter className="min-h-11 shrink-0 flex-wrap gap-2 border-t px-5 py-1.5 sm:px-6 [.border-t]:pt-1.5">
                {footer}
            </CardFooter>
        </Card>
    );
}

type AvailableAttendance = Extract<AttendanceData, {status: 'available'}>;

function BrowserAccessContent({
    status,
    isFetching,
    onRetry,
}: {
    status: BrowserAccessStatus;
    isFetching: boolean;
    onRetry: () => void;
}) {
    if (status === 'not-applicable') {
        return (
            <div className="text-sm leading-6">
                <p className="font-medium">
                    출석과 D-Day는 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다.
                </p>
                <Button asChild className="mt-2" size="sm" variant="outline">
                    <Link to="/connections">앱 연결 안내</Link>
                </Button>
            </div>
        );
    }
    if (status === 'checking') {
        return (
            <div className="space-y-2" aria-label="PC 연결 상태 확인 중">
                <Skeleton className="h-10 w-full" />
                <p className="text-sm text-muted-foreground">PC 연결 상태를 확인하고 있습니다.</p>
            </div>
        );
    }
    if (status === 'unconnected') {
        return (
            <div className="text-sm leading-6">
                <p className="font-medium">출석과 D-Day 확인을 위해 PC 연결이 필요합니다.</p>
                <Button asChild className="mt-2" size="sm" variant="outline">
                    <Link to="/connections">기기 연결 열기</Link>
                </Button>
            </div>
        );
    }
    return (
        <div className="text-sm leading-6">
            <p className="text-destructive">PC 연결 상태를 확인하지 못했습니다.</p>
            <Button
                className="mt-2"
                disabled={isFetching}
                size="sm"
                variant="outline"
                onClick={onRetry}
            >
                {isFetching ? '새로고침 중' : '새로고침'}
            </Button>
        </div>
    );
}

function DesktopAccessContent({
    status,
    connectionFetching,
    refreshPending,
    onConnectionRetry,
    onRefreshAttendance,
}: {
    status: DesktopAccessStatus;
    connectionFetching: boolean;
    refreshPending: boolean;
    onConnectionRetry: () => void;
    onRefreshAttendance: () => void;
}) {
    if (status === 'lms-checking') {
        return (
            <div className="space-y-2" aria-label="LMS 로그인 상태 확인 중">
                <Skeleton className="h-10 w-full" />
                <p className="text-sm text-muted-foreground">
                    LMS 로그인 상태를 확인하고 있습니다.
                </p>
            </div>
        );
    }
    if (status === 'lms-required') {
        return (
            <div className="text-sm leading-6">
                <p className="font-medium">LMS 로그인이 필요합니다.</p>
            </div>
        );
    }
    if (status === 'lms-unavailable') {
        return (
            <div className="text-sm leading-6">
                <p className="text-destructive">LMS 로그인 상태를 확인하지 못했습니다.</p>
                <Button
                    className="mt-2"
                    disabled={connectionFetching}
                    size="sm"
                    variant="outline"
                    onClick={onConnectionRetry}
                >
                    {connectionFetching ? '새로고침 중' : '새로고침'}
                </Button>
            </div>
        );
    }
    if (status === 'session-checking') {
        return (
            <div className="space-y-2" aria-label="계정 연결 상태 확인 중">
                <Skeleton className="h-10 w-full" />
                <p className="text-sm text-muted-foreground">계정 연결 상태를 확인하고 있습니다.</p>
            </div>
        );
    }
    if (status === 'session-recovery-required') {
        return (
            <div className="text-sm leading-6">
                <p className="text-destructive">계정 복구가 필요합니다.</p>
                <Button asChild className="mt-2" size="sm" variant="outline">
                    <Link to="/connections">연결 설정</Link>
                </Button>
            </div>
        );
    }
    return (
        <div className="text-sm leading-6">
            <p className="font-medium">계정 연결이 필요합니다.</p>
            <Button
                className="mt-2"
                disabled={refreshPending}
                size="sm"
                onClick={onRefreshAttendance}
            >
                {refreshPending ? '연결 중' : '계정 연결'}
            </Button>
        </div>
    );
}

function AttendanceStaleContent({
    attendance,
    refreshPending,
    onRefresh,
}: {
    attendance: AvailableAttendance;
    refreshPending: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="text-sm leading-6">
            <p className="font-medium text-amber-800 dark:text-amber-300">
                마지막 출석 확인 이후 시간이 지났습니다.
            </p>
            <p className="mt-1 text-muted-foreground">
                마지막 확인 · {dateTimeLabel(attendance.lastSyncedAt)}
            </p>
            <Button
                className="mt-2"
                disabled={refreshPending}
                size="sm"
                variant="outline"
                onClick={onRefresh}
            >
                {refreshPending ? '새로고침 중' : '새로고침'}
            </Button>
        </div>
    );
}

function DifferentAttendanceDayContent({
    attendance,
    refreshPending,
    onRefresh,
}: {
    attendance: AvailableAttendance;
    refreshPending: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="text-sm leading-6">
            <p className="font-medium">새 출석일 상태를 확인하고 있습니다.</p>
            <p className="mt-1 text-muted-foreground">
                마지막 확인 · {dateTimeLabel(attendance.lastSyncedAt)}
            </p>
            <Button
                className="mt-2"
                disabled={refreshPending}
                size="sm"
                variant="outline"
                onClick={onRefresh}
            >
                {refreshPending ? '확인 중' : '지금 확인'}
            </Button>
        </div>
    );
}

function AttendanceReadyContent({
    attendance,
    refreshFailed,
}: {
    attendance: AvailableAttendance | null;
    refreshFailed: boolean;
}) {
    return (
        <>
            {attendance ? <AttendanceChecks snapshot={attendance.snapshot} /> : null}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                    {attendance
                        ? `${attendance.source === 'desktop' ? '마지막 확인' : '마지막 동기화'} · ${dateTimeLabel(attendance.lastSyncedAt)}`
                        : '동기화 기록 없음'}
                </span>
                {attendance?.syncState === 'pending' ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                        <RefreshCw aria-hidden="true" className="size-3" /> 다른 기기 동기화 대기 중
                    </span>
                ) : refreshFailed ? (
                    <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                        <RefreshCw aria-hidden="true" className="size-3" /> 마지막 확인값 표시 중
                    </span>
                ) : null}
            </div>
        </>
    );
}

function AttendanceContent({
    state,
    refreshPending,
    onRefresh,
}: {
    state: CampusAttendanceContentState;
    refreshPending: boolean;
    onRefresh: () => void;
}) {
    if (state.kind === 'loading') {
        return (
            <div className="space-y-2" aria-label="출석 정보를 불러오는 중">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </div>
        );
    }
    if (state.kind === 'error') {
        return (
            <div className="text-sm">
                <p className="text-destructive">출석 정보를 불러오지 못했습니다.</p>
                <Button
                    className="mt-2"
                    disabled={refreshPending}
                    size="sm"
                    variant="outline"
                    onClick={onRefresh}
                >
                    {refreshPending ? '새로고침 중' : '새로고침'}
                </Button>
            </div>
        );
    }
    if (state.kind === 'authentication-required') {
        return (
            <p className="text-sm leading-6 text-muted-foreground">
                PC 앱과 다시 연결하면 오늘 출석 상태가 표시됩니다.
            </p>
        );
    }
    if (state.kind === 'unavailable') {
        return (
            <p className="text-sm leading-6 text-muted-foreground">
                PC에서 처음 출석 정보를 동기화하기를 기다리고 있습니다.
            </p>
        );
    }
    if (state.kind === 'stale') {
        return (
            <AttendanceStaleContent
                attendance={state.attendance}
                refreshPending={refreshPending}
                onRefresh={onRefresh}
            />
        );
    }
    if (state.kind === 'different-attendance-day') {
        return (
            <DifferentAttendanceDayContent
                attendance={state.attendance}
                refreshPending={refreshPending}
                onRefresh={onRefresh}
            />
        );
    }
    return (
        <AttendanceReadyContent attendance={state.attendance} refreshFailed={state.refreshFailed} />
    );
}

function CampusSummaryContent({
    accessState,
    attendanceState,
    browserSessionFetching,
    connectionFetching,
    refreshPending,
    onBrowserSessionRetry,
    onConnectionRetry,
    onRefreshAttendance,
}: {
    accessState: CampusAccessState;
    attendanceState: CampusAttendanceContentState;
    browserSessionFetching: boolean;
    connectionFetching: boolean;
    refreshPending: boolean;
    onBrowserSessionRetry: () => void;
    onConnectionRetry: () => void;
    onRefreshAttendance: () => void;
}) {
    if (accessState.kind === 'browser') {
        return (
            <BrowserAccessContent
                status={accessState.status}
                isFetching={browserSessionFetching}
                onRetry={onBrowserSessionRetry}
            />
        );
    }
    if (accessState.kind === 'desktop') {
        return (
            <DesktopAccessContent
                status={accessState.status}
                connectionFetching={connectionFetching}
                refreshPending={refreshPending}
                onConnectionRetry={onConnectionRetry}
                onRefreshAttendance={onRefreshAttendance}
            />
        );
    }
    return (
        <AttendanceContent
            state={attendanceState}
            refreshPending={refreshPending}
            onRefresh={onRefreshAttendance}
        />
    );
}

function campusOpenLabel(isPending: boolean, lmsAuthenticationRequired: boolean): string {
    if (isPending) return '여는 중';
    return lmsAuthenticationRequired ? 'LMS 로그인' : '정글캠퍼스 열기';
}

function CampusCardActions({
    lmsWindowAvailable,
    lmsAuthenticationRequired,
    opening,
    openFailed,
    onOpen,
}: {
    lmsWindowAvailable: boolean;
    lmsAuthenticationRequired: boolean;
    opening: boolean;
    openFailed: boolean;
    onOpen: () => void;
}) {
    return (
        <>
            {lmsWindowAvailable ? (
                <Button size="sm" disabled={opening} onClick={onOpen}>
                    {campusOpenLabel(opening, lmsAuthenticationRequired)} <ExternalLinkIcon />
                </Button>
            ) : (
                <Button asChild size="sm">
                    <ExternalLink href={CAMPUS_URL}>
                        정글캠퍼스 열기 <ExternalLinkIcon />
                    </ExternalLink>
                </Button>
            )}
            <Button asChild size="sm" variant="link" className="px-1">
                <Link to="/attendance">
                    출석 상세 보기 <ArrowRight />
                </Link>
            </Button>
            {openFailed ? (
                <span className="text-xs text-destructive">정글캠퍼스를 열지 못했습니다.</span>
            ) : null}
        </>
    );
}

export function JungleCampusSummary() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const attendance = useAttendanceQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
    // Opening the LMS window does not mutate query-backed application state.
    // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
    const openCampus = useMutation({mutationFn: () => api.openLmsLogin()});

    const desktopLocalAttendanceAvailable =
        platform.capabilities.desktopAccount &&
        attendance.data?.state === 'loaded' &&
        attendance.data.attendance.status === 'available' &&
        attendance.data.attendance.source === 'desktop';
    const personalReady =
        account.personalAccess.status === 'connected' || desktopLocalAttendanceAvailable;
    const accessState = resolveCampusAccessState({
        platformKind: platform.kind,
        desktopAccount: platform.capabilities.desktopAccount,
        desktopLocalAttendanceAvailable,
        personalAccessStatus: account.personalAccess.status,
        accountStatus: account.status,
    });
    const attendanceState = resolveCampusAttendanceContentState({
        personalReady,
        isPending: attendance.isPending,
        isError: attendance.isError,
        data: attendance.data,
    });
    const dday = personalReady
        ? selectDdayView({
              platform: platform.kind,
              attendance: attendance.data,
          })
        : null;

    return (
        <div className="space-y-4" data-home-campus-section="true">
            <CampusCardFrame
                footer={
                    <CampusCardActions
                        lmsWindowAvailable={platform.capabilities.lmsWindow}
                        lmsAuthenticationRequired={account.status.lmsAuthentication === 'required'}
                        opening={openCampus.isPending}
                        openFailed={openCampus.isError}
                        onOpen={() => openCampus.mutate()}
                    />
                }
            >
                <CampusSummaryContent
                    accessState={accessState}
                    attendanceState={attendanceState}
                    browserSessionFetching={account.browserSessionQuery.isFetching}
                    connectionFetching={account.connectionQuery.isFetching}
                    refreshPending={refreshAttendance.isPending}
                    onBrowserSessionRetry={() => void account.browserSessionQuery.refetch()}
                    onConnectionRetry={() => void account.connectionQuery.refetch()}
                    onRefreshAttendance={() => refreshAttendance.mutate()}
                />
            </CampusCardFrame>
            {dday ? <DdayCard view={dday} /> : null}
        </div>
    );
}
