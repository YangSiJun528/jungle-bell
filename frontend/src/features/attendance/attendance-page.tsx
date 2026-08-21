import {useMutation} from '@tanstack/react-query';
import {CalendarCheck2, Check, ExternalLink, Laptop, RefreshCw, X} from 'lucide-react';

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
import {selectDdayView} from '@/domain/attendance/dday-view';
import {dateTimeLabel, relativeTimeLabel} from '@/lib/format';

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

export function AttendancePage() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const attendance = useAttendanceQuery();
    const desktopConnection = useDesktopConnectionQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
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
    const campusNotice = lmsState === 'login-required' ? 'LMS 로그인이 필요합니다.' : null;
    const desktopLmsChecking =
        platform.capabilities.desktopAccount && account.status.lmsAuthentication === 'checking';
    const desktopLmsRequired =
        platform.capabilities.desktopAccount && account.status.lmsAuthentication === 'required';
    const desktopLmsUnavailable =
        platform.capabilities.desktopAccount && account.status.lmsAuthentication === 'unavailable';
    const desktopLocalAttendanceAvailable =
        platform.capabilities.desktopAccount &&
        detail.kind === 'available' &&
        detail.source === 'desktop';
    const desktopSessionChecking =
        platform.capabilities.desktopAccount &&
        !desktopLocalAttendanceAvailable &&
        account.status.serverSession === 'checking';
    const desktopSessionMissing =
        platform.capabilities.desktopAccount &&
        !desktopLocalAttendanceAvailable &&
        account.status.serverSession === 'missing';
    const desktopSessionRecovery =
        platform.capabilities.desktopAccount &&
        !desktopLocalAttendanceAvailable &&
        account.status.serverSession === 'recovery-required';
    const browserAccessChecking =
        platform.kind === 'browser' && account.personalAccess.status === 'checking';
    const browserAccessUnavailable =
        platform.kind === 'browser' && account.personalAccess.status === 'not-applicable';
    const browserAccessUnconnected =
        platform.kind === 'browser' && account.personalAccess.status === 'unconnected';
    const browserAccessError =
        platform.kind === 'browser' && account.personalAccess.status === 'error';

    const dday = selectDdayView({
        platform: platform.kind,
        attendance: attendance.data,
    });

    return (
        <div className="space-y-6">
            <PageHeader
                title="출석"
                actions={
                    desktopLmsRequired ? (
                        <Button disabled={openCampus.isPending} onClick={() => openCampus.mutate()}>
                            <ExternalLink aria-hidden="true" />
                            {openCampus.isPending ? '여는 중' : 'LMS 로그인'}
                        </Button>
                    ) : (
                        <Button
                            variant="outline"
                            disabled={
                                refreshAttendance.isPending ||
                                (account.personalAccess.status !== 'connected' &&
                                    !desktopLocalAttendanceAvailable) ||
                                desktopLmsChecking ||
                                desktopLmsUnavailable ||
                                desktopSessionChecking ||
                                desktopSessionRecovery
                            }
                            onClick={() => refreshAttendance.mutate()}
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={refreshAttendance.isPending ? 'animate-spin' : ''}
                            />
                            {refreshAttendance.isPending
                                ? '새로고침 중'
                                : desktopLmsChecking
                                  ? '인증 확인 중'
                                  : desktopSessionMissing && !desktopLocalAttendanceAvailable
                                    ? '계정 연결'
                                    : '새로고침'}
                        </Button>
                    )
                }
            />

            {refreshAttendance.isError ? (
                <Alert variant="destructive">
                    <RefreshCw aria-hidden="true" />
                    <AlertTitle>최신 상태를 동기화하지 못했습니다.</AlertTitle>
                    <AlertDescription>
                        {refreshAttendance.error.message === 'LMS_AUTH_REQUIRED'
                            ? 'LMS 로그인 후 다시 시도하세요.'
                            : '네트워크와 PC 앱의 실행 상태를 확인한 뒤 다시 시도하세요.'}
                    </AlertDescription>
                </Alert>
            ) : null}

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
                <Card
                    aria-live="polite"
                    aria-busy={!browserAccessUnavailable && detail.kind === 'loading'}
                >
                    <CardHeader>
                        <CardTitle>오늘 출석</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {browserAccessUnavailable ? (
                            <EmptyState
                                title="앱 연결이 필요합니다."
                                description="출석은 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다."
                            />
                        ) : browserAccessChecking ? (
                            <LoadingState label="PC 연결 상태를 확인하고 있습니다." />
                        ) : browserAccessUnconnected ? (
                            <EmptyState
                                title="PC 연결이 필요합니다."
                                description="PC 앱과 연결한 뒤 출석과 D-Day를 확인할 수 있습니다."
                            />
                        ) : browserAccessError ? (
                            <ErrorState
                                title="PC 연결 상태를 확인하지 못했습니다."
                                retry={() => void account.browserSessionQuery.refetch()}
                            />
                        ) : desktopLmsChecking ? (
                            <LoadingState label="LMS 로그인 상태를 확인하고 있습니다." />
                        ) : desktopLmsRequired ? (
                            <EmptyState title="LMS 로그인이 필요합니다." />
                        ) : desktopLmsUnavailable ? (
                            <ErrorState
                                title="LMS 로그인 상태를 확인하지 못했습니다."
                                retry={() => void account.connectionQuery.refetch()}
                            />
                        ) : desktopSessionChecking ? (
                            <LoadingState label="계정 연결 상태를 확인하고 있습니다." />
                        ) : desktopSessionRecovery ? (
                            <EmptyState
                                title="계정 복구가 필요합니다."
                                description="연결 설정에서 PC 연결 정보를 복구하세요."
                            />
                        ) : desktopSessionMissing ? (
                            <EmptyState
                                title="계정 연결이 필요합니다."
                                description="계정 연결을 누르면 출석 동기화를 시작합니다."
                            />
                        ) : detail.kind === 'loading' ? (
                            <LoadingState label="출석 정보를 확인하고 있습니다." />
                        ) : detail.kind === 'error' ? (
                            <ErrorState retry={() => void attendance.refetch()} />
                        ) : detail.kind === 'auth-required' ? (
                            <EmptyState
                                title="PC 연결이 필요합니다."
                                description="PC 앱과 연결한 뒤 최신 출석 상태를 확인할 수 있습니다."
                            />
                        ) : detail.kind === 'unavailable' ? (
                            <EmptyState
                                title="출석 확인 대기 중"
                                description="아직 PC에서 동기화한 출석 정보가 없습니다."
                            />
                        ) : (
                            <div className="space-y-4">
                                <div>
                                    <p className="text-xs text-muted-foreground">출석 기준일</p>
                                    <p className="mt-1 text-lg font-semibold">
                                        {calendarDateLabel(detail.snapshot.attendanceDate)}
                                    </p>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <AttendanceCheck
                                        label="학습 시작"
                                        checked={detail.snapshot.morningChecked}
                                    />
                                    <AttendanceCheck
                                        label="학습 종료"
                                        checked={detail.snapshot.eveningChecked}
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {detail.source === 'desktop' ? '마지막 확인' : '마지막 동기화'}{' '}
                                    · {dateTimeLabel(detail.lastSyncedAt)}
                                </p>
                                {detail.syncState === 'pending' ? (
                                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <RefreshCw aria-hidden="true" className="size-3" /> 다른
                                        기기 동기화 대기 중
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
                        )}
                    </CardContent>
                </Card>

                <Card className="border-primary/20 bg-primary/5">
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                                <CalendarCheck2 aria-hidden="true" className="size-5" />
                            </span>
                            <div>
                                <p className="text-xs font-medium text-muted-foreground">
                                    공식 서비스
                                </p>
                                <CardTitle className="mt-1">정글캠퍼스</CardTitle>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <CardDescription className="leading-6">
                            공식 정글캠퍼스에서 출석 원본 상태를 확인하거나 로그인하세요.
                            {platform.capabilities.lmsWindow
                                ? ' LMS 세션은 이 PC의 앱에만 저장됩니다.'
                                : ''}
                        </CardDescription>
                        {primaryDevice?.lastSeenAt ? (
                            <p className="text-xs text-muted-foreground">
                                PC 마지막 확인 · {relativeTimeLabel(primaryDevice.lastSeenAt)}
                            </p>
                        ) : null}
                        {campusNotice ? (
                            <p className="text-sm text-amber-800 dark:text-amber-300">
                                {campusNotice}
                            </p>
                        ) : null}
                        {openCampus.isError ? (
                            <p className="text-sm text-destructive">
                                정글캠퍼스를 열지 못했습니다.
                            </p>
                        ) : null}
                    </CardContent>
                    <CardFooter className="border-t">
                        {platform.capabilities.lmsWindow ? (
                            <Button
                                disabled={openCampus.isPending}
                                onClick={() => openCampus.mutate()}
                            >
                                {openCampus.isPending ? '여는 중' : '정글캠퍼스 열기'}{' '}
                                <ExternalLink />
                            </Button>
                        ) : (
                            <Button asChild>
                                <a href={CAMPUS_URL} target="_blank" rel="noopener noreferrer">
                                    정글캠퍼스 열기 <ExternalLink />
                                </a>
                            </Button>
                        )}
                    </CardFooter>
                </Card>
            </section>

            {dday ? <DdayCard view={dday} /> : null}

            {devices.length > 0 ? (
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
                                                    {device.appVersion
                                                        ? ` · v${device.appVersion}`
                                                        : ''}
                                                </p>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
}

export default AttendancePage;
