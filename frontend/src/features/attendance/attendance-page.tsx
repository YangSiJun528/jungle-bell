import {useMutation} from '@tanstack/react-query';
import {
    CalendarCheck2,
    Check,
    ExternalLink as ExternalLinkIcon,
    Laptop,
    RefreshCw,
    X,
} from 'lucide-react';

import type {DesktopDevice} from '@/api/dashboard-api';
import {useDashboardAccount} from '@/app/dashboard-account';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {
    useAttendanceQuery,
    useDesktopConnectionQuery,
    useRefreshAttendanceMutation,
} from '@/app/use-dashboard-queries';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {DdayCard} from '@/components/dashboard/dday-card';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {ExternalLink} from '@/components/ui/external-link';
import {selectDdayView} from '@/domain/attendance/dday-view';
import {dateTimeLabel, relativeTimeLabel} from '@/lib/format';

import {
    resolveAttendancePageState,
    type AttendanceContentState,
    type AttendancePageState,
    type AttendanceRetryTarget,
} from './attendance-page-state';
import {attendanceDetailModel, deviceStatus} from './attendance-view-model';

const CAMPUS_URL = 'https://jungle-lms.krafton.com/check-in';

function calendarDateLabel(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    return match ? `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일` : value;
}

function AttendanceCheck({label, checked}: {label: string; checked: boolean}) {
    return (
        <div
            className={
                checked
                    ? 'rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-emerald-800 dark:text-emerald-200'
                    : 'rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-200'
            }
        >
            <span className="flex items-center gap-2 text-sm font-medium">
                {checked ? (
                    <Check aria-hidden="true" className="size-4" />
                ) : (
                    <X aria-hidden="true" className="size-4" />
                )}
                {label}
            </span>
            <strong className="mt-3 block text-xl">{checked ? '완료' : '미완료'}</strong>
        </div>
    );
}

function AttendanceDevicesCard({devices}: {devices: DesktopDevice[]}) {
    if (devices.length === 0) return null;

    return (
        <Card>
            <CardHeader>
                <div>
                    <p className="text-xs font-medium text-muted-foreground">수집 기기</p>
                    <CardTitle className="mt-1">출석 확인 PC</CardTitle>
                </div>
            </CardHeader>
            <CardContent>
                <ul className="divide-y rounded-xl border">
                    {devices.map((device) => {
                        const status = deviceStatus(device);
                        return (
                            <li
                                key={device.id}
                                className="flex items-center justify-between gap-4 p-4"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                                        <Laptop aria-hidden="true" className="size-4" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">
                                            {device.deviceLabel || '내 PC'}
                                        </p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {device.lastSeenAt
                                                ? relativeTimeLabel(device.lastSeenAt)
                                                : '확인 기록 없음'}
                                            {` · ${status.label}`}
                                            {device.appVersion ? ` · v${device.appVersion}` : ''}
                                        </p>
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </CardContent>
        </Card>
    );
}

function AttendancePageHeader({
    state,
    openingCampus,
    refreshing,
    onOpenCampus,
    onRefresh,
}: {
    state: AttendancePageState;
    openingCampus: boolean;
    refreshing: boolean;
    onOpenCampus: () => void;
    onRefresh: () => void;
}) {
    if (state.desktopLmsRequired) {
        return (
            <PageHeader
                title="출석"
                actions={
                    <Button disabled={openingCampus} onClick={onOpenCampus}>
                        <ExternalLinkIcon aria-hidden="true" />
                        {openingCampus ? '여는 중' : 'LMS 로그인'}
                    </Button>
                }
            />
        );
    }

    return (
        <PageHeader
            title="출석"
            actions={
                <Button
                    variant="outline"
                    disabled={state.refreshControl.disabled}
                    onClick={onRefresh}
                >
                    <RefreshCw aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
                    {state.refreshControl.label}
                </Button>
            }
        />
    );
}

function AttendanceRefreshError({errorMessage}: {errorMessage: string | null}) {
    if (errorMessage === null) return null;

    return (
        <Alert variant="destructive">
            <RefreshCw aria-hidden="true" />
            <AlertTitle>최신 상태를 동기화하지 못했습니다.</AlertTitle>
            <AlertDescription>
                {errorMessage === 'LMS_AUTH_REQUIRED'
                    ? 'LMS 로그인 후 다시 시도하세요.'
                    : '네트워크와 PC 앱의 실행 상태를 확인한 뒤 다시 시도하세요.'}
            </AlertDescription>
        </Alert>
    );
}

function AvailableAttendance({
    detail,
}: {
    detail: Extract<AttendanceContentState, {kind: 'available'}>['detail'];
}) {
    return (
        <div className="space-y-4">
            <div>
                <p className="text-xs text-muted-foreground">출석 기준일</p>
                <p className="mt-1 text-lg font-semibold">
                    {calendarDateLabel(detail.snapshot.attendanceDate)}
                </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <AttendanceCheck label="학습 시작" checked={detail.snapshot.morningChecked} />
                <AttendanceCheck label="학습 종료" checked={detail.snapshot.eveningChecked} />
            </div>
            <p className="text-xs text-muted-foreground">
                {detail.source === 'desktop' ? '마지막 확인' : '마지막 동기화'} ·{' '}
                {dateTimeLabel(detail.lastSyncedAt)}
            </p>
            {detail.syncState === 'pending' ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <RefreshCw aria-hidden="true" className="size-3" /> 다른 기기 동기화 대기 중
                </p>
            ) : null}
            {detail.freshness === 'stale' ? (
                <Alert className="border-amber-500/25 bg-amber-500/10 text-amber-900 dark:text-amber-200">
                    <RefreshCw aria-hidden="true" />
                    <AlertTitle>마지막 확인 이후 시간이 지났습니다.</AlertTitle>
                    <AlertDescription className="text-current/80">
                        PC 앱을 실행하고 새로고침을 눌러 확인하세요.
                    </AlertDescription>
                </Alert>
            ) : null}
        </div>
    );
}

type RetryActions = Record<AttendanceRetryTarget, () => void>;

function AttendanceContent({
    content,
    retryActions,
}: {
    content: AttendanceContentState;
    retryActions: RetryActions;
}) {
    if (content.kind === 'loading') return <LoadingState label={content.label} />;
    if (content.kind === 'empty') {
        return <EmptyState title={content.title} description={content.description} />;
    }
    if (content.kind === 'error') {
        return <ErrorState title={content.title} retry={retryActions[content.retryTarget]} />;
    }
    return <AvailableAttendance detail={content.detail} />;
}

function TodayAttendanceCard({
    state,
    retryActions,
}: {
    state: AttendancePageState;
    retryActions: RetryActions;
}) {
    return (
        <Card aria-live="polite" aria-busy={state.attendanceBusy}>
            <CardHeader>
                <CardTitle>오늘 출석</CardTitle>
            </CardHeader>
            <CardContent>
                <AttendanceContent content={state.content} retryActions={retryActions} />
            </CardContent>
        </Card>
    );
}

function JungleCampusCard({
    campusNotice,
    lastSeenAt,
    lmsWindow,
    openError,
    opening,
    onOpen,
}: {
    campusNotice: string | null;
    lastSeenAt?: string | null;
    lmsWindow: boolean;
    openError: boolean;
    opening: boolean;
    onOpen: () => void;
}) {
    return (
        <Card className="border-primary/20 bg-primary/5">
            <CardHeader>
                <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                        <CalendarCheck2 aria-hidden="true" className="size-5" />
                    </span>
                    <div>
                        <p className="text-xs font-medium text-muted-foreground">공식 서비스</p>
                        <CardTitle className="mt-1">정글캠퍼스</CardTitle>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                <CardDescription className="leading-6">
                    공식 정글캠퍼스에서 출석 원본 상태를 확인하거나 로그인하세요.
                    {lmsWindow ? ' LMS 세션은 이 PC의 앱에만 저장됩니다.' : ''}
                </CardDescription>
                {lastSeenAt ? (
                    <p className="text-xs text-muted-foreground">
                        PC 마지막 확인 · {relativeTimeLabel(lastSeenAt)}
                    </p>
                ) : null}
                {campusNotice ? (
                    <p className="text-sm text-amber-800 dark:text-amber-300">{campusNotice}</p>
                ) : null}
                {openError ? (
                    <p className="text-sm text-destructive">정글캠퍼스를 열지 못했습니다.</p>
                ) : null}
            </CardContent>
            <CardFooter className="border-t">
                {lmsWindow ? (
                    <Button disabled={opening} onClick={onOpen}>
                        {opening ? '여는 중' : '정글캠퍼스 열기'} <ExternalLinkIcon />
                    </Button>
                ) : (
                    <Button asChild>
                        <ExternalLink href={CAMPUS_URL}>
                            정글캠퍼스 열기 <ExternalLinkIcon />
                        </ExternalLink>
                    </Button>
                )}
            </CardFooter>
        </Card>
    );
}

function AttendancePageView({
    campusNotice,
    dday,
    devices,
    lastSeenAt,
    lmsWindow,
    openCampusError,
    openingCampus,
    refreshErrorMessage,
    refreshing,
    retryActions,
    state,
    onOpenCampus,
    onRefresh,
}: {
    campusNotice: string | null;
    dday: ReturnType<typeof selectDdayView>;
    devices: DesktopDevice[];
    lastSeenAt?: string | null;
    lmsWindow: boolean;
    openCampusError: boolean;
    openingCampus: boolean;
    refreshErrorMessage: string | null;
    refreshing: boolean;
    retryActions: RetryActions;
    state: AttendancePageState;
    onOpenCampus: () => void;
    onRefresh: () => void;
}) {
    return (
        <div className="space-y-6">
            <AttendancePageHeader
                state={state}
                openingCampus={openingCampus}
                refreshing={refreshing}
                onOpenCampus={onOpenCampus}
                onRefresh={onRefresh}
            />
            <AttendanceRefreshError errorMessage={refreshErrorMessage} />

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
                <TodayAttendanceCard state={state} retryActions={retryActions} />
                <JungleCampusCard
                    campusNotice={campusNotice}
                    lastSeenAt={lastSeenAt}
                    lmsWindow={lmsWindow}
                    openError={openCampusError}
                    opening={openingCampus}
                    onOpen={onOpenCampus}
                />
            </section>

            {dday ? <DdayCard view={dday} /> : null}

            <AttendanceDevicesCard devices={devices} />
        </div>
    );
}

export function AttendancePage() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const attendance = useAttendanceQuery();
    const desktopConnection = useDesktopConnectionQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
    // Opening the LMS window does not mutate query-backed application state.
    // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
    const openCampus = useMutation({mutationFn: () => api.openLmsLogin()});
    const detail = attendanceDetailModel({
        isPending: attendance.isPending,
        isError: attendance.isError,
        data: attendance.data,
    });
    const devices = attendance.data?.state === 'loaded' ? attendance.data.devices : [];
    const primaryDevice = devices[0];
    const lmsState = platform.capabilities.desktopAccount
        ? desktopConnection.data?.lmsSessionState
        : primaryDevice?.lmsSessionState;
    const state = resolveAttendancePageState({
        accountStatus: account.status,
        desktopAccount: platform.capabilities.desktopAccount,
        detail,
        personalAccessStatus: account.personalAccess.status,
        platformKind: platform.kind,
        refreshPending: refreshAttendance.isPending,
    });
    const retryActions: RetryActions = {
        attendance: () => void attendance.refetch(),
        'browser-session': () => void account.browserSessionQuery.refetch(),
        'desktop-connection': () => void account.connectionQuery.refetch(),
    };

    return (
        <AttendancePageView
            campusNotice={lmsState === 'login-required' ? 'LMS 로그인이 필요합니다.' : null}
            dday={selectDdayView({platform: platform.kind, attendance: attendance.data})}
            devices={devices}
            lastSeenAt={primaryDevice?.lastSeenAt}
            lmsWindow={platform.capabilities.lmsWindow}
            openCampusError={openCampus.isError}
            openingCampus={openCampus.isPending}
            refreshErrorMessage={refreshAttendance.isError ? refreshAttendance.error.message : null}
            refreshing={refreshAttendance.isPending}
            retryActions={retryActions}
            state={state}
            onOpenCampus={() => openCampus.mutate()}
            onRefresh={() => refreshAttendance.mutate()}
        />
    );
}

export default AttendancePage;
